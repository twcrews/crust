import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import { isToolResult, type MessageUpdateEvent, type Model, type RpcEvent, type SlashCommand, type ToolExecutionEndEvent, type ToolExecutionStartEvent, type ToolExecutionUpdateEvent } from '../pi/rpcTypes';
import { getCrustOutputChannel, logCrust, type CrustLogLevel } from '../utils/crustLogger';
import { errorMessage } from '../utils/errorMessage';
import { parseWebviewMessage, type SessionInfo } from './chatTypes';
import { getChatWebviewHtml } from './chatWebview';
import { buildPromptWithIdeContext, extractRestoredPrompt, getIdeContext } from './ideContext';
import { getBlockText, getBlockType, getEntryTimestamp, getMessageContent, getMessageRole, getMessageText, getMessageTimestamp, parseJsonObject } from './messageUtils';
import { getPathSuggestions } from './pathAutocomplete';
import { listSessions } from './sessionHistory';
import { getToolBody, getToolHeaderDetail, getToolResultText, isRenderableTool } from './toolUtils';
import { formatUsageStatus } from './usageStatus';

const execFileAsync = promisify(execFile);

type ConversationState = {
	isProcessing: boolean;
	isStreaming: boolean;
	activeThinkingMessageId: string | undefined;
	activeLoadingMessageId: string | undefined;
	hasSessionTitle: boolean;
	activeToolCallIds: Map<string, string>;
	activeToolCallArgs: Map<string, unknown>;
	activeTextMessageIds: Map<number, string>;
	activeAbortIndicatorShown: boolean;
	usageMessages: unknown[];
	activeUsageMessage: unknown;
};

function createConversationState(): ConversationState {
	return {
		isProcessing: false,
		isStreaming: false,
		activeThinkingMessageId: undefined,
		activeLoadingMessageId: undefined,
		hasSessionTitle: false,
		activeToolCallIds: new Map<string, string>(),
		activeToolCallArgs: new Map<string, unknown>(),
		activeTextMessageIds: new Map<number, string>(),
		activeAbortIndicatorShown: false,
		usageMessages: [],
		activeUsageMessage: undefined,
	};
}

export class CrustChatPanel implements vscode.Disposable {
	private static readonly viewType = 'crustChat';
	private readonly output = getCrustOutputChannel();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cwd: string | undefined;
	private readonly client: PiRpcClient;
	private models: Model[] = [];
	private currentModel: Model | undefined;
	private contextWindow: number | undefined;
	private readonly notifiedErrors = new Set<string>();
	private conversationState = createConversationState();
	private lastActiveTextEditor = vscode.window.activeTextEditor;
	private piSlashCommands: SlashCommand[] = [];
	private builtinSlashCommands: SlashCommand[] = [];
	private activeSessionPath: string | undefined;
	private sessionWatcher: FSWatcher | undefined;
	private sessionWatcherTimer: NodeJS.Timeout | undefined;

	static show(context: vscode.ExtensionContext): void {
		void CrustChatPanel.open(context);
	}

	static registerSerializer(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerWebviewPanelSerializer(CrustChatPanel.viewType, {
			deserializeWebviewPanel: async (panel, state: unknown) => {
				panel.webview.options = { enableScripts: true };
				const sessionPath = typeof (state as { sessionPath?: unknown } | undefined)?.sessionPath === 'string'
					? (state as { sessionPath: string }).sessionPath
					: undefined;
				new CrustChatPanel(context, panel, sessionPath);
			},
		});
	}

	private static async open(context: vscode.ExtensionContext): Promise<void> {
		const panel = vscode.window.createWebviewPanel(
			CrustChatPanel.viewType,
			'Crust Chat',
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		const chatPanel = new CrustChatPanel(context, panel);
		await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
		chatPanel.focusPrompt();
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
		private readonly restoredSessionPath?: string,
	) {
		this.cwd = this.getInitialCwd();
		this.client = new PiRpcClient(this.cwd);
		this.log('Creating chat panel', { cwd: this.cwd });
		this.panel.iconPath = this.getIconPath();
		this.panel.webview.html = getChatWebviewHtml(this.context.extensionUri, this.panel.webview);

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleWebviewMessage(message)),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.lastActiveTextEditor = editor;
				}
				this.postIdeContext();
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				if (event.textEditor === this.lastActiveTextEditor) {
					this.postIdeContext();
				}
			}),
			this.client.onEvent((event) => this.handlePiEvent(event)),
			this.client.onError((message) => this.handleClientError(message)),
		);

		void this.initialize();
	}

	dispose(): void {
		this.log('Disposing chat panel');
		this.client.dispose();
		this.disposeSessionWatcher();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getInitialCwd(): string | undefined {
		const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
		if (activeDocumentUri?.scheme === 'file') {
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocumentUri)?.uri.fsPath;
			if (workspaceFolder) {
				return workspaceFolder;
			}

			return this.getFileBackedCwd(activeDocumentUri.fsPath) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		}
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private getFileBackedCwd(filePath: string): string | undefined {
		const parts = filePath.split(/[\\/]+/);
		const piIndex = parts.lastIndexOf('.pi');
		if (piIndex > 0) {
			return parts.slice(0, piIndex).join('/') || (filePath.startsWith('/') ? '/' : undefined);
		}
		return dirname(filePath);
	}

	private async initialize(): Promise<void> {
		this.postIdeContext();
		try {
			this.log('Initializing Pi RPC client');
			await this.client.start();
			const [models, initialState, commands, builtinCommands] = await Promise.all([
				this.client.getAvailableModels(),
				this.client.getState(),
				this.client.getCommands(),
				this.getBuiltinSlashCommands(),
			]);
			let state = initialState;
			if (this.restoredSessionPath && this.getSessionPath(state) !== this.restoredSessionPath) {
				try {
					this.log('Switching to restored webview session', { path: this.restoredSessionPath });
					if (await this.client.switchSession(this.restoredSessionPath)) {
						state = await this.client.getState();
					}
				} catch (error) {
					this.log('Failed to switch to restored webview session', { error: errorMessage(error), path: this.restoredSessionPath }, 'warn');
				}
			}
			const messages = await this.client.getMessages();
			this.models = models;
			this.piSlashCommands = commands;
			this.builtinSlashCommands = builtinCommands;
			const currentModel = (state as { model?: Model | null } | undefined)?.model;
			this.currentModel = currentModel ?? undefined;
			this.contextWindow = this.getModelContextWindow(currentModel);
			const sessionPath = this.getSessionPath(state);
			this.post({ type: 'sessionPath', sessionPath });
			this.watchSessionFile(sessionPath);
			this.post({ type: 'sessionTitle', title: 'New Chat' });
			this.postModels();
			this.postSlashCommands();
			if (this.restoredSessionPath && messages.length) {
				await this.restoreMessages(messages);
			} else {
				await this.postSessionStatus(messages);
			}
			this.log('Initialized chat panel', { modelCount: models.length, messageCount: messages.length, commandCount: commands.length, contextWindow: this.contextWindow });
		} catch (error) {
			const message = errorMessage(error);
			this.log('Failed to initialize chat panel', { error: message }, 'error');
			this.postError(`Unable to start Pi RPC: ${message}`);
			if (this.isPiNotInstalledError(message)) {
				this.showPiNotInstalledToast(message);
			}
		}
	}

	private async handleWebviewMessage(rawMessage: unknown): Promise<void> {
		const message = parseWebviewMessage(rawMessage);
		if (!message) {
			this.log('Ignoring invalid webview message', undefined, 'warn');
			return;
		}
		this.log('Received webview message', { type: message.type });
		switch (message.type) {
			case 'submit':
				await this.submitPrompt(message.text ?? '', message.includeIdeContext !== false);
				break;
			case 'steer':
				await this.steerPrompt(message.text ?? '');
				break;
			case 'cancel':
				await this.cancelPrompt();
				break;
			case 'selectModel':
				await this.selectModel(message.modelKey);
				break;
			case 'showHistory':
				await this.showHistory();
				break;
			case 'newChat':
				await this.newChat();
				break;
			case 'slashCommand':
				await this.runSlashCommand(message.commandName ?? '', message.commandText ?? '');
				break;
			case 'pathAutocomplete':
				await this.postPathAutocomplete(message.requestId, message.query ?? '');
				break;
			case 'refreshSlashCommands':
				await this.refreshSlashCommands();
				break;
			case 'webviewLog':
				this.log(`Webview: ${message.message ?? ''}`, message.details, message.level ?? 'info');
				break;
		}
	}

	private handleClientError(message: string): void {
		this.postError(message);
		if (this.isPiNotInstalledError(message)) {
			this.showPiNotInstalledToast(message);
		}
	}

	private isPiNotInstalledError(message: string): boolean {
		return /\bENOENT\b|spawn pi|command not found|not found/i.test(message);
	}

	private showPiNotInstalledToast(details: string): void {
		const key = 'pi-not-installed';
		if (!this.trackActiveNotification(key)) {
			return;
		}
		void Promise.resolve(vscode.window.showErrorMessage('Crust could not find the `pi` command. Install Pi Coding Agent or add it to your PATH.', 'Install Pi', 'Open Logs')).then((action) => {
			if (action === 'Install Pi') {
				void vscode.env.openExternal(vscode.Uri.parse('https://pi.dev/'));
			}
			if (action === 'Open Logs') {
				this.output.show();
			}
		}).finally(() => this.notifiedErrors.delete(key));
		this.log('Showing Pi not installed notification', { error: details });
	}

	private showModelConnectionToast(message: string): void {
		const key = `model-connection:${this.currentModel ? this.modelKey(this.currentModel) : 'unknown'}:${message}`;
		if (!this.trackActiveNotification(key)) {
			return;
		}
		const modelLabel = this.currentModel ? this.modelLabel(this.currentModel) : 'the selected model';
		void Promise.resolve(vscode.window.showErrorMessage(`Crust received an error from ${modelLabel}. ${message}`, 'Switch Model', 'Open Logs')).then((action) => {
			if (action === 'Switch Model') {
				this.post({ type: 'focusModel' });
			}
			if (action === 'Open Logs') {
				this.output.show();
			}
		}).finally(() => this.notifiedErrors.delete(key));
	}

	private trackActiveNotification(key: string): boolean {
		if (this.notifiedErrors.has(key)) {
			return false;
		}
		this.notifiedErrors.add(key);
		return true;
	}

	private async newChat(): Promise<void> {
		if (this.conversationState.isStreaming) {
			void vscode.window.showInformationMessage('Wait for the current response to finish before starting a new chat.');
			return;
		}

		try {
			this.log('Starting new chat');
			const switched = await this.client.newSession();
			if (!switched) {
				return;
			}
			this.resetConversationState();
			this.post({ type: 'clearMessages' });
			this.post({ type: 'sessionTitle', title: 'New Chat' });
			await this.postCurrentSessionPath();
			await this.postSessionStatus([]);
			this.postIdeContext();
			void this.refreshSlashCommands();
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'newChat' });
		}
	}

	private async showHistory(): Promise<void> {
		try {
			this.log('Loading session history');
			const sessions = await listSessions(this.client, this.cwd);
			if (!sessions.length) {
				void vscode.window.showInformationMessage('No previous Pi sessions found.');
				return;
			}

			const selected = await vscode.window.showQuickPick(
				sessions.map((session) => ({
					label: session.name || this.truncate(session.firstMessage, 80),
					description: this.formatSessionDate(session.modified),
					detail: `${session.messageCount} messages · ${session.path}`,
					session,
				})),
				{ placeHolder: 'Select a Pi session to restore' },
			);
			if (!selected) {
				return;
			}

			this.log('Selected session from history', { path: selected.session.path });
			await this.restoreSession(selected.session);
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'showHistory' });
		}
	}

	private async restoreSession(session: SessionInfo): Promise<void> {
		this.log('Restoring session', { path: session.path });
		const switched = await this.client.switchSession(session.path);
		if (!switched) {
			return;
		}

		this.resetConversationState();
		this.post({ type: 'clearMessages' });

		const messages = await this.client.getMessages();
		this.log('Fetched session messages', { count: messages.length });
		await this.restoreMessages(messages, session.name);
		await this.postCurrentSessionPath();
		void this.refreshSlashCommands();
	}

	private async restoreMessages(messages: unknown[], sessionName?: string): Promise<void> {
		const restoredToolCalls = new Map<string, { elementId: string; name?: string; args?: unknown }>();
		let firstUserMessage: string | undefined;
		for (const message of messages) {
			const restoredFirstUserMessage = this.restoreMessage(message, restoredToolCalls);
			firstUserMessage ??= restoredFirstUserMessage;
		}

		const title = sessionName ? extractRestoredPrompt(sessionName).text : firstUserMessage || 'New Chat';
		this.conversationState.hasSessionTitle = Boolean(firstUserMessage || sessionName);
		this.post({ type: 'sessionTitle', title: this.truncate(title, 50) });
		await this.postSessionStatus(messages);
	}

	private resetConversationState(): void {
		const wasProcessing = this.conversationState.isProcessing;
		this.conversationState = createConversationState();
		if (wasProcessing) {
			this.post({ type: 'processing', processing: false });
		}
	}

	private restoreMessage(
		message: unknown,
		toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>,
	): string | undefined {
		const role = getMessageRole(message);
		if (role === 'user') {
			const restoredPrompt = extractRestoredPrompt(getMessageText(message).trim());
			const slashCommandLabel = restoredPrompt.skillLabel ?? this.getSlashCommandLabel(restoredPrompt.text);
			if (restoredPrompt.text || slashCommandLabel) {
				this.post({
					type: 'addMessage',
					id: this.createId('user'),
					role: 'user',
					text: slashCommandLabel && !restoredPrompt.skillLabel ? '' : restoredPrompt.text,
					ideContextLabel: restoredPrompt.ideContextLabel,
					slashCommandLabel,
				});
				return slashCommandLabel ?? restoredPrompt.text;
			}
			return undefined;
		}

		if (role === 'assistant') {
			this.restoreAssistantMessage(message, toolCalls);
			return undefined;
		}

		if (role === 'toolResult') {
			this.restoreToolResult(message, toolCalls);
			return undefined;
		}

		const text = getMessageText(message).trim();
		if (text) {
			this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text });
		}
		return undefined;
	}

	private restoreAssistantMessage(
		message: unknown,
		toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>,
	): void {
		const content = getMessageContent(message);
		if (typeof content === 'string') {
			this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text: content });
			this.restoreAbortIndicator(message);
			return;
		}

		if (!Array.isArray(content)) {
			this.restoreAbortIndicator(message);
			return;
		}

		for (const block of content) {
			const type = getBlockType(block);
			if (type === 'text') {
				const text = getBlockText(block, 'text').trim();
				if (text) {
					this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text });
				}
			}
			if (type === 'thinking') {
				const thinking = getBlockText(block, 'thinking');
				if (thinking.trim()) {
					const id = this.createId('thinking');
					this.post({ type: 'addThinking', id });
					this.post({ type: 'appendThinking', id, text: thinking });
				}
			}
			if (type === 'toolCall') {
				this.restoreToolCall(block, toolCalls);
			}
		}
		this.restoreAbortIndicator(message);
	}

	private restoreAbortIndicator(message: unknown): void {
		if (!this.isAbortedAssistantMessage(message)) {
			return;
		}
		this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text: `_${this.getAbortMessage(message)}_`, secondary: true });
	}

	private restoreToolCall(block: unknown, toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>): void {
		const record = block as { id?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown; args?: unknown };
		const toolCallId = typeof record.id === 'string' ? record.id : this.createId('restored-toolcall-id');
		const name = typeof record.name === 'string' ? record.name : typeof record.toolName === 'string' ? record.toolName : undefined;
		const args = record.arguments ?? record.args;
		if (!isRenderableTool(name)) {
			return;
		}

		const elementId = this.createId('restored-tool');
		toolCalls.set(toolCallId, { elementId, name, args });
		this.post({
			type: 'upsertTool',
			id: elementId,
			toolName: name,
			path: getToolHeaderDetail(name, args),
			status: 'pending',
			body: getToolBody(name, args),
			isDiff: name === 'edit',
		});
	}

	private restoreToolResult(message: unknown, toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>): void {
		const record = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
		const toolCall = typeof record.toolCallId === 'string' ? toolCalls.get(record.toolCallId) : undefined;
		const name = typeof record.toolName === 'string' ? record.toolName : toolCall?.name;
		if (!isRenderableTool(name)) {
			return;
		}

		const result = isToolResult(message) ? message : undefined;
		const diff = typeof result?.details?.diff === 'string' ? result.details.diff : undefined;
		const isError = record.isError === true;
		this.post({
			type: 'upsertTool',
			id: toolCall?.elementId ?? this.createId('restored-tool'),
			toolName: name,
			path: getToolHeaderDetail(name, toolCall?.args, isError ? undefined : result),
			status: isError ? 'error' : 'done',
			body: name === 'read' && !isError ? undefined : diff ?? getToolResultText(result) ?? getToolBody(name, toolCall?.args),
			isDiff: Boolean(diff),
		});
	}

	private async refreshUsageStatus(): Promise<void> {
		try {
			await this.postSessionStatus(await this.client.getMessages());
		} catch {
			// Usage is informational; avoid replacing a more useful status with an error.
		}
	}

	private finalizeUsageStatus(message: unknown): void {
		if (!this.hasMessageUsage(message)) {
			void this.refreshUsageStatus();
			return;
		}
		this.conversationState.usageMessages = [...this.conversationState.usageMessages, message];
		this.conversationState.activeUsageMessage = undefined;
		this.postCurrentUsageStatus();
	}

	private async postSessionStatus(messages: unknown[]): Promise<void> {
		this.conversationState.usageMessages = messages;
		this.conversationState.activeUsageMessage = undefined;
		if (!messages.length) {
			this.post({ type: 'status', message: await this.getWorkspaceStatus() });
			return;
		}
		this.postCurrentUsageStatus();
	}

	private async refreshSlashCommands(): Promise<void> {
		try {
			this.piSlashCommands = await this.client.getCommands();
			this.postSlashCommands();
		} catch (error) {
			this.log('Failed to refresh slash commands', { error: errorMessage(error) }, 'warn');
		}
	}

	private postSlashCommands(): void {
		const commands = this.dedupeSlashCommands([
			...this.builtinSlashCommands,
			...this.piSlashCommands,
		]);
		this.log('Posting slash commands', {
			cwd: this.cwd,
			builtinCount: this.builtinSlashCommands.length,
			piCount: this.piSlashCommands.length,
			totalCount: commands.length,
			commandNames: commands.slice(0, 50).map((command) => command.name),
		});
		this.post({ type: 'slashCommands', commands });
	}

	private dedupeSlashCommands(commands: SlashCommand[]): SlashCommand[] {
		const byName = new Map<string, SlashCommand>();
		for (const command of commands) {
			if (!byName.has(command.name)) {
				byName.set(command.name, command);
			}
		}
		return [...byName.values()];
	}

	private async getBuiltinSlashCommands(): Promise<SlashCommand[]> {
		try {
			const { stdout } = await execFileAsync('which', ['pi']);
			const piCliPath = await realpath(stdout.trim());
			const source = await readFile(join(dirname(piCliPath), 'core', 'slash-commands.js'), 'utf8');
			const commands: SlashCommand[] = [];
			for (const match of source.matchAll(/\{\s*name:\s*"([^"]+)",\s*description:\s*(?:"([^"]*)"|`([^`]*)`)\s*\}/g)) {
				commands.push({ name: match[1], description: (match[2] ?? match[3]).replace(/\$\{APP_NAME\}/g, 'Pi'), source: 'builtin' });
			}
			return commands.length ? commands : [{ name: 'new', description: 'Start a new session', source: 'builtin' }];
		} catch (error) {
			this.log('Failed to load Pi builtin slash commands', { error: errorMessage(error) }, 'warn');
			return [{ name: 'new', description: 'Start a new session', source: 'builtin' }];
		}
	}

	private async runSlashCommand(commandName: string, commandText: string): Promise<void> {
		if (this.piSlashCommands.some((command) => command.name === commandName)) {
			const invocation = commandText.trim() || `/${commandName}`;
			await this.submitPrompt(invocation, false, { text: '', slashCommandLabel: invocation.split(/\r?\n/, 1)[0] });
			void this.refreshSlashCommands();
			return;
		}

		await this.runBuiltinSlashCommand(commandName, commandText);
	}

	private async postPathAutocomplete(requestId: number | undefined, query: string): Promise<void> {
		if (typeof requestId !== 'number') {
			return;
		}
		this.post({ type: 'pathAutocomplete', requestId, suggestions: await getPathSuggestions(this.cwd, query) });
	}

	private getSlashCommandLabel(text: string): string | undefined {
		const firstLine = text.trim().split(/\r?\n/, 1)[0];
		const commandName = firstLine.match(/^\/([^\s/]+)(?:\s|$)/)?.[1];
		if (!commandName) {
			return undefined;
		}
		if (commandName.startsWith('skill:')) {
			return firstLine;
		}
		if (!this.piSlashCommands.some((command) => command.name === commandName)) {
			return undefined;
		}
		return firstLine;
	}

	private async runBuiltinSlashCommand(commandName: string, commandText: string): Promise<void> {
		const args = commandText.trim().slice(commandName.length + 1).trim();
		switch (commandName) {
			case 'new':
				await this.newChat();
				return;
			case 'compact':
				await this.client.compact(args || undefined);
				await this.postSessionStatus(await this.client.getMessages());
				return;
			case 'name':
				await this.client.setSessionName(args);
				this.post({ type: 'sessionTitle', title: args || 'New Chat' });
				return;
			case 'resume':
				await this.showHistory();
				return;
			case 'model':
				this.post({ type: 'focusModel' });
				return;
			default:
				this.postError(`/${commandName} is a Pi TUI command and is not available in Crust yet.`);
		}
	}

	private async getWorkspaceStatus(): Promise<string> {
		if (!this.cwd) {
			return 'No workspace folder';
		}

		const workspaceName = basename(this.cwd) || this.cwd;
		const branch = await this.getGitBranch();
		return branch ? `${workspaceName} - ${branch}` : `${workspaceName} - no branch`;
	}

	private async getGitBranch(): Promise<string | undefined> {
		if (!this.cwd) {
			return undefined;
		}
		try {
			const { stdout } = await execFileAsync('git', ['-C', this.cwd, 'branch', '--show-current']);
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private postCurrentUsageStatus(): void {
		const messages = this.conversationState.activeUsageMessage === undefined ? this.conversationState.usageMessages : [...this.conversationState.usageMessages, this.conversationState.activeUsageMessage];
		this.post({ type: 'status', message: formatUsageStatus(messages, this.contextWindow) });
	}

	private postIdeContext(): void {
		const ideContext = getIdeContext(this.lastActiveTextEditor);
		this.post({ type: 'ideContext', label: ideContext?.label });
	}

	private async postCurrentSessionPath(): Promise<void> {
		try {
			const sessionPath = this.getSessionPath(await this.client.getState());
			this.post({ type: 'sessionPath', sessionPath });
			this.watchSessionFile(sessionPath);
		} catch (error) {
			this.log('Failed to post current session path', { error: errorMessage(error) }, 'warn');
		}
	}

	private setCurrentModel(model: Model | undefined): void {
		const previousKey = this.currentModel ? this.modelKey(this.currentModel) : undefined;
		const nextKey = model ? this.modelKey(model) : undefined;
		this.currentModel = model;
		this.contextWindow = this.getModelContextWindow(model);
		if (previousKey !== nextKey) {
			this.log('Current model changed', { previous: previousKey, current: nextKey });
		}
		this.postModels();
		if (this.conversationState.usageMessages.length) {
			this.postCurrentUsageStatus();
		}
	}

	private postModels(): void {
		const models = [...this.models];
		if (this.currentModel && !models.some((model) => this.modelKey(model) === this.modelKey(this.currentModel!))) {
			models.push(this.currentModel);
		}
		this.post({ type: 'models', models, selected: this.currentModel ? this.modelKey(this.currentModel) : undefined });
	}

	private async refreshCurrentModel(): Promise<void> {
		if (await this.refreshCurrentModelFromSessionFile()) {
			return;
		}
		try {
			const state = await this.client.getState();
			const model = (state as { model?: Model | null } | undefined)?.model ?? undefined;
			if (model) {
				this.setCurrentModel(model);
			}
		} catch (error) {
			this.log('Failed to refresh current model from Pi state', { error: errorMessage(error) }, 'warn');
		}
	}

	private async refreshCurrentModelFromSessionFile(): Promise<boolean> {
		if (!this.activeSessionPath) {
			return false;
		}
		try {
			const text = await readFile(this.activeSessionPath, 'utf8');
			const model = this.getLastModelFromSessionText(text);
			if (!model) {
				return false;
			}
			this.setCurrentModel(model);
			return true;
		} catch (error) {
			this.log('Failed to refresh current model from session file', { error: errorMessage(error), path: this.activeSessionPath }, 'warn');
			return false;
		}
	}

	private getLastModelFromSessionText(text: string): Model | undefined {
		let latest: Model | undefined;
		for (const line of text.split(/\r?\n/)) {
			const entry = parseJsonObject(line);
			if (!entry) {
				continue;
			}
			if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
				latest = this.findKnownModel(entry.provider, entry.modelId) ?? { provider: entry.provider, id: entry.modelId };
				continue;
			}
			const message = entry.message;
			if (entry.type === 'message' && getMessageRole(message) === 'assistant' && typeof (message as { provider?: unknown }).provider === 'string' && typeof (message as { model?: unknown }).model === 'string') {
				const provider = (message as { provider: string }).provider;
				const modelId = (message as { model: string }).model;
				latest = this.findKnownModel(provider, modelId) ?? { provider, id: modelId };
			}
		}
		return latest;
	}

	private findKnownModel(provider: string, modelId: string): Model | undefined {
		return this.models.find((model) => model.provider === provider && model.id === modelId);
	}

	private watchSessionFile(sessionPath: string | undefined): void {
		if (this.activeSessionPath === sessionPath) {
			return;
		}
		this.disposeSessionWatcher();
		this.activeSessionPath = sessionPath;
		if (!sessionPath) {
			return;
		}
		try {
			this.sessionWatcher = watch(sessionPath, () => {
				if (this.sessionWatcherTimer) {
					clearTimeout(this.sessionWatcherTimer);
				}
				this.sessionWatcherTimer = setTimeout(() => {
					this.sessionWatcherTimer = undefined;
					void this.refreshCurrentModelFromSessionFile();
				}, 100);
			});
		} catch (error) {
			this.log('Failed to watch session file for model changes', { error: errorMessage(error), path: sessionPath }, 'warn');
		}
	}

	private disposeSessionWatcher(): void {
		if (this.sessionWatcherTimer) {
			clearTimeout(this.sessionWatcherTimer);
			this.sessionWatcherTimer = undefined;
		}
		this.sessionWatcher?.close();
		this.sessionWatcher = undefined;
	}

	private async submitPrompt(text: string, includeIdeContext: boolean, display?: { text?: string; slashCommandLabel?: string }): Promise<void> {
		const trimmed = text.trim();
		const displayText = display?.text ?? trimmed;
		const ideContext = includeIdeContext ? getIdeContext(this.lastActiveTextEditor) : undefined;
		const promptText = ideContext ? buildPromptWithIdeContext(trimmed, ideContext) : trimmed;
		this.log('Submitting prompt', { length: trimmed.length, promptLength: promptText.length, followUp: this.conversationState.isStreaming, ideContext: ideContext?.label, slashCommand: display?.slashCommandLabel });
		if (!trimmed) {
			return;
		}

		await this.refreshCurrentModel();

		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(display?.slashCommandLabel ?? displayText);
		}

		const userMessageId = this.createId('user');
		this.conversationState.activeLoadingMessageId = this.createId('loading');
		this.conversationState.activeTextMessageIds.clear();
		this.conversationState.activeAbortIndicatorShown = false;
		this.post({ type: 'addMessage', id: userMessageId, role: 'user', text: displayText, ideContextLabel: ideContext?.label, slashCommandLabel: display?.slashCommandLabel });
		this.post({ type: 'addMessage', id: this.conversationState.activeLoadingMessageId, role: 'assistant', text: '', loading: true });
		this.setProcessing(true);
		this.conversationState.activeUsageMessage = undefined;
		if (this.conversationState.usageMessages.length) {
			this.postCurrentUsageStatus();
		}

		try {
			await this.client.prompt(promptText, this.conversationState.isStreaming ? 'followUp' : undefined);
		} catch (error) {
			const message = errorMessage(error);
			this.log('Prompt failed', { error: message }, 'error');
			const assistantMessageId = this.getStreamingTextMessageId(0);
			this.post({ type: 'appendMessage', id: assistantMessageId, text: `\nError: ${message}` });
			this.removeActiveLoadingMessage();
			this.setProcessing(false);
		}
	}

	private async steerPrompt(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		if (!this.conversationState.isProcessing) {
			await this.submitPrompt(trimmed, true);
			return;
		}

		try {
			this.log('Steering prompt', { length: trimmed.length });
			this.post({ type: 'addMessage', id: this.createId('user'), role: 'user', text: trimmed });
			await this.client.steer(trimmed);
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'steerPrompt' });
		}
	}

	private async cancelPrompt(): Promise<void> {
		if (!this.conversationState.isProcessing) {
			return;
		}

		try {
			this.log('Cancelling prompt');
			await this.client.abort();
			const lastAssistant = (await this.client.getMessages()).slice().reverse().find((message) => getMessageRole(message) === 'assistant');
			this.showAbortIndicator(lastAssistant);
			this.post({ type: 'status', message: 'Stopped.' });
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'cancelPrompt' });
		} finally {
			this.setProcessing(false);
			this.conversationState.isStreaming = false;
			this.conversationState.activeThinkingMessageId = undefined;
			this.conversationState.activeToolCallIds.clear();
			this.conversationState.activeToolCallArgs.clear();
			this.conversationState.activeTextMessageIds.clear();
			this.removeActiveLoadingMessage();
		}
	}

	private async selectModel(modelKey: string | undefined): Promise<void> {
		const model = this.models.find((candidate) => this.modelKey(candidate) === modelKey);
		if (!model) {
			return;
		}

		try {
			await this.client.setModel(model);
			this.setCurrentModel(model);
			await this.postSessionStatus(await this.client.getMessages());
		} catch (error) {
			const message = errorMessage(error);
			this.postError(message, { operation: 'selectModel' });
			this.showModelConnectionToast(message);
		}
	}

	private handlePiEvent(event: RpcEvent): void {
		if (event.type === 'model_select' && event.model) {
			this.setCurrentModel(event.model);
			return;
		}
		if (event.type === 'agent_start') {
			this.setProcessing(true);
			this.conversationState.isStreaming = true;
			this.conversationState.activeThinkingMessageId = undefined;
			this.conversationState.activeToolCallIds.clear();
			this.conversationState.activeToolCallArgs.clear();
			this.conversationState.activeTextMessageIds.clear();
			this.conversationState.activeAbortIndicatorShown = false;
			return;
		}

		if (event.type === 'agent_end') {
			this.showAbortIndicator(event.message);
			const errorMessage = this.getAssistantErrorMessage(event.message);
			if (errorMessage) {
				this.showModelConnectionToast(errorMessage);
			}
			this.setProcessing(false);
			this.conversationState.isStreaming = false;
			this.conversationState.activeThinkingMessageId = undefined;
			this.conversationState.activeToolCallIds.clear();
			this.conversationState.activeToolCallArgs.clear();
			this.conversationState.activeTextMessageIds.clear();
			this.removeActiveLoadingMessage();
			this.finalizeUsageStatus(event.message);
			void this.postCurrentSessionPath();
			void this.refreshCurrentModel();
			return;
		}

		if (event.type === 'tool_execution_start') {
			this.showToolExecutionStart(event);
			return;
		}

		if (event.type === 'tool_execution_update') {
			this.showToolExecutionUpdate(event);
			return;
		}

		if (event.type === 'tool_execution_end') {
			this.showToolExecutionEnd(event);
			return;
		}

		if (event.type !== 'message_update') {
			return;
		}

		this.showStreamingUsage(event);
		this.showStreamingThinking(event);
		this.showStreamingToolCall(event);
		this.showAbortIndicator(event.message);

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
			this.post({ type: 'appendMessage', id: this.getStreamingTextMessageId(assistantEvent.contentIndex ?? 0), text: assistantEvent.delta });
		}

		if (assistantEvent?.type === 'error') {
			const assistantErrorMessage = this.getAssistantErrorMessage(event.message);
			const message = assistantErrorMessage ?? assistantEvent.reason ?? 'unknown error';
			this.post({ type: 'appendMessage', id: this.getStreamingTextMessageId(assistantEvent.contentIndex ?? 0), text: `\nError: ${message}` });
			if (assistantErrorMessage) {
				this.showModelConnectionToast(assistantErrorMessage);
			}
		}
	}

	private showAbortIndicator(message: unknown): void {
		if (this.conversationState.activeAbortIndicatorShown || !this.isAbortedAssistantMessage(message)) {
			return;
		}
		this.conversationState.activeAbortIndicatorShown = true;
		this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text: `_${this.getAbortMessage(message)}_`, secondary: true });
	}

	private getAssistantErrorMessage(message: unknown): string | undefined {
		if (
			getMessageRole(message) !== 'assistant'
			|| typeof message !== 'object'
			|| message === null
			|| (message as { stopReason?: unknown }).stopReason !== 'error'
		) {
			return undefined;
		}
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		return typeof errorMessage === 'string' && errorMessage ? errorMessage : 'Unknown error';
	}

	private isAbortedAssistantMessage(message: unknown): boolean {
		return getMessageRole(message) === 'assistant'
			&& typeof message === 'object'
			&& message !== null
			&& (message as { stopReason?: unknown }).stopReason === 'aborted';
	}

	private getAbortMessage(message: unknown): string {
		if (typeof message !== 'object' || message === null) {
			return 'Operation aborted';
		}
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		return typeof errorMessage === 'string' && errorMessage && errorMessage !== 'Request was aborted'
			? errorMessage
			: 'Operation aborted';
	}

	private getStreamingTextMessageId(contentIndex: number): string {
		const existing = this.conversationState.activeTextMessageIds.get(contentIndex);
		if (existing) {
			return existing;
		}

		const id = this.createId('assistant');
		this.conversationState.activeTextMessageIds.set(contentIndex, id);
		this.post({ type: 'addMessage', id, role: 'assistant', text: '' });
		return id;
	}

	private removeActiveLoadingMessage(): void {
		if (!this.conversationState.activeLoadingMessageId) {
			return;
		}
		this.post({ type: 'removeMessage', id: this.conversationState.activeLoadingMessageId });
		this.conversationState.activeLoadingMessageId = undefined;
	}

	private showToolExecutionStart(event: ToolExecutionStartEvent): void {
		if (!isRenderableTool(event.toolName)) {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.conversationState.activeToolCallArgs.get(event.toolCallId) : undefined);
		const id = this.toolElementId(event.toolCallId);
		this.post({
			type: 'upsertTool',
			id,
			toolName: event.toolName,
			path: getToolHeaderDetail(event.toolName, args),
			status: 'running',
			body: getToolBody(event.toolName, args),
		});
	}

	private showToolExecutionUpdate(event: ToolExecutionUpdateEvent): void {
		if (!isRenderableTool(event.toolName) || event.toolName === 'read') {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.conversationState.activeToolCallArgs.get(event.toolCallId) : undefined);
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: getToolHeaderDetail(event.toolName, args),
			status: 'running',
			body: getToolResultText(event.partialResult),
		});
	}

	private showToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (!isRenderableTool(event.toolName)) {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.conversationState.activeToolCallArgs.get(event.toolCallId) : undefined);
		const diff = typeof event.result?.details?.diff === 'string' ? event.result.details.diff : undefined;
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: getToolHeaderDetail(event.toolName, args, event.isError ? undefined : event.result),
			status: event.isError ? 'error' : 'done',
			body: event.toolName === 'read' ? undefined : diff ?? getToolResultText(event.result) ?? getToolBody(event.toolName, args),
			isDiff: Boolean(diff),
		});
	}

	private showStreamingUsage(event: MessageUpdateEvent): void {
		if (event.message === undefined || !this.hasMessageUsage(event.message)) {
			return;
		}
		this.conversationState.activeUsageMessage = event.message;
		this.postCurrentUsageStatus();
	}

	private hasMessageUsage(message: unknown): boolean {
		if (typeof message !== 'object' || message === null) {
			return false;
		}
		const record = message as { usage?: unknown; message?: unknown };
		const usage = record.usage ?? (typeof record.message === 'object' && record.message !== null ? (record.message as { usage?: unknown }).usage : undefined);
		return typeof usage === 'object' && usage !== null;
	}

	private showStreamingThinking(event: MessageUpdateEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'thinking_start') {
			this.conversationState.activeThinkingMessageId = undefined;
			return;
		}

		if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
			if (!this.conversationState.activeThinkingMessageId) {
				this.conversationState.activeThinkingMessageId = this.createId('thinking');
				this.post({ type: 'addThinking', id: this.conversationState.activeThinkingMessageId });
			}
			this.post({ type: 'appendThinking', id: this.conversationState.activeThinkingMessageId, text: assistantEvent.delta });
		}
	}

	private showStreamingToolCall(event: MessageUpdateEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (!assistantEvent?.type.startsWith('toolcall_')) {
			return;
		}

		const toolCall = this.extractToolCall(event);
		if (!isRenderableTool(toolCall.name)) {
			return;
		}

		if (toolCall.id && toolCall.args !== undefined) {
			this.conversationState.activeToolCallArgs.set(toolCall.id, toolCall.args);
		}
		const contentIndex = assistantEvent.contentIndex ?? 0;
		const indexKey = `index:${contentIndex}`;
		const toolKey = toolCall.id ? `id:${toolCall.id}` : indexKey;
		const existingId = this.conversationState.activeToolCallIds.get(toolKey) ?? this.conversationState.activeToolCallIds.get(indexKey);
		const id = toolCall.id ? this.toolElementId(toolCall.id) : existingId ?? this.createId('toolcall');
		if (toolCall.id) {
			const temporaryId = this.conversationState.activeToolCallIds.get(indexKey);
			if (temporaryId && temporaryId !== id) {
				this.post({ type: 'removeMessage', id: temporaryId });
			}
			this.conversationState.activeToolCallIds.delete(indexKey);
		}
		this.conversationState.activeToolCallIds.set(toolKey, id);
		this.post({
			type: 'upsertTool',
			id,
			toolName: toolCall.name,
			path: getToolHeaderDetail(toolCall.name, toolCall.args),
			status: assistantEvent.type === 'toolcall_end' ? 'pending' : 'drafting',
			body: getToolBody(toolCall.name, toolCall.args),
			isDiff: toolCall.name === 'edit',
		});
	}

	private extractToolCall(event: MessageUpdateEvent): { id?: string; name?: string; args?: unknown } {
		const assistantEvent = event.assistantMessageEvent;
		const candidates = [
			assistantEvent?.toolCall,
			assistantEvent?.partial,
			this.getMessageContentAt(event.message, assistantEvent?.contentIndex),
		];
		const candidate = candidates.find((value) => typeof value === 'object' && value !== null);
		const record = candidate as { id?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown; args?: unknown } | undefined;
		return {
			id: typeof record?.id === 'string' ? record.id : event.toolCallId,
			name: typeof record?.name === 'string' ? record.name : typeof record?.toolName === 'string' ? record.toolName : undefined,
			args: record?.arguments ?? record?.args,
		};
	}

	private getMessageContentAt(message: unknown, contentIndex: number | undefined): unknown {
		if (typeof message !== 'object' || message === null || contentIndex === undefined) {
			return undefined;
		}
		const content = (message as { content?: unknown }).content;
		return Array.isArray(content) ? content[contentIndex] : undefined;
	}

	private toolElementId(toolCallId: string | undefined): string {
		return `tool-${toolCallId ?? this.createId('unknown')}`;
	}

	private formatSessionDate(date: Date): string {
		return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
	}

	private truncate(text: string, maxLength: number): string {
		return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
	}

	private focusPrompt(): void {
		this.post({ type: 'focusPrompt' });
	}

	private setProcessing(isProcessing: boolean): void {
		if (this.conversationState.isProcessing === isProcessing) {
			return;
		}
		this.conversationState.isProcessing = isProcessing;
		this.post({ type: 'processing', processing: isProcessing });
	}

	private post(message: unknown): void {
		this.log('Posting webview message', this.getPostLogDetails(message));
		void this.panel.webview.postMessage(message);
	}

	private getPostLogDetails(message: unknown): Record<string, unknown> | undefined {
		if (typeof message !== 'object' || message === null) {
			return undefined;
		}
		const record = message as { type?: unknown; id?: unknown; role?: unknown; text?: unknown; status?: unknown };
		return {
			type: record.type,
			id: record.id,
			role: record.role,
			status: record.status,
			textLength: typeof record.text === 'string' ? record.text.length : undefined,
		};
	}

	private postError(message: string, details?: unknown): void {
		this.log(message, details, 'error');
		this.post({ type: 'error', message });
	}

	private log(message: string, details?: unknown, level: CrustLogLevel = 'info'): void {
		logCrust(message, details, level);
	}

	private setSessionTitleFromPrompt(prompt: string): void {
		this.conversationState.hasSessionTitle = true;
		const title = prompt.length > 50 ? `${prompt.slice(0, 47)}...` : prompt;
		this.post({ type: 'sessionTitle', title });
	}

	private modelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	private modelLabel(model: Model): string {
		return `${model.name ?? model.id} (${model.provider})`;
	}

	private getModelContextWindow(model: Model | null | undefined): number | undefined {
		const contextWindow = (model as { contextWindow?: unknown } | null | undefined)?.contextWindow;
		return typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? contextWindow : undefined;
	}

	private getSessionPath(state: unknown): string | undefined {
		const sessionFile = (state as { sessionFile?: unknown } | undefined)?.sessionFile;
		return typeof sessionFile === 'string' ? sessionFile : undefined;
	}

	private createId(prefix: string): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	private getIconPath(): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
		const icon = vscode.Uri.joinPath(this.context.extensionUri, 'branding', 'icon-small.svg');
		return { light: icon, dark: icon };
	}
}
