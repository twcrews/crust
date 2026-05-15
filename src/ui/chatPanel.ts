import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import type { Model, RpcEvent, SlashCommand } from '../pi/rpcTypes';
import type { SessionInfo, WebviewMessage } from './chatTypes';
import { getChatWebviewHtml } from './chatWebview';
import { buildPromptWithIdeContext, extractRestoredPrompt, getIdeContext } from './ideContext';
import { getBlockText, getBlockType, getEntryTimestamp, getMessageContent, getMessageRole, getMessageText, getMessageTimestamp, parseJsonObject } from './messageUtils';
import { getPathSuggestions } from './pathAutocomplete';
import { listSessions } from './sessionHistory';
import { getToolBody, getToolHeaderDetail, getToolResultText, isRenderableTool } from './toolUtils';
import { formatUsageStatus } from './usageStatus';

const execFileAsync = promisify(execFile);

export class CrustChatPanel implements vscode.Disposable {
	private static currentPanel: CrustChatPanel | undefined;
	private readonly output = vscode.window.createOutputChannel('Crust');
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cwd: string | undefined;
	private readonly client: PiRpcClient;
	private models: Model[] = [];
	private contextWindow: number | undefined;
	private isStreaming = false;
	private activeThinkingMessageId: string | undefined;
	private activeLoadingMessageId: string | undefined;
	private hasSessionTitle = false;
	private activeToolCallIds = new Map<string, string>();
	private activeToolCallArgs = new Map<string, unknown>();
	private activeTextMessageIds = new Map<number, string>();
	private usageMessages: unknown[] = [];
	private activeUsageMessage: unknown;
	private lastActiveTextEditor = vscode.window.activeTextEditor;
	private piSlashCommands: SlashCommand[] = [];
	private builtinSlashCommands: SlashCommand[] = [];

	static show(context: vscode.ExtensionContext): void {
		void CrustChatPanel.open(context);
	}

	private static async open(context: vscode.ExtensionContext): Promise<void> {
		if (CrustChatPanel.currentPanel) {
			CrustChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
			await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'crustChat',
			'Crust Chat',
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		CrustChatPanel.currentPanel = new CrustChatPanel(context, panel);
		await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
	) {
		this.cwd = this.getInitialCwd();
		this.client = new PiRpcClient(this.cwd);
		this.log('Creating chat panel', { cwd: this.cwd });
		this.panel.iconPath = this.getIconPath();
		this.panel.webview.html = getChatWebviewHtml(this.context.extensionUri, this.panel.webview);

		this.disposables.push(
			this.output,
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleWebviewMessage(message)),
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
			this.client.onError((message) => this.post({ type: 'error', message })),
		);

		void this.initialize();
	}

	dispose(): void {
		this.log('Disposing chat panel');
		CrustChatPanel.currentPanel = undefined;
		this.client.dispose();
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
			const [models, state, messages, commands, builtinCommands] = await Promise.all([
				this.client.getAvailableModels(),
				this.client.getState(),
				this.client.getMessages(),
				this.client.getCommands(),
				this.getBuiltinSlashCommands(),
			]);
			this.models = models;
			this.piSlashCommands = commands;
			this.builtinSlashCommands = builtinCommands;
			const currentModel = (state as { model?: Model | null } | undefined)?.model;
			this.contextWindow = this.getModelContextWindow(currentModel);
			this.post({ type: 'sessionTitle', title: 'New Chat' });
			this.post({ type: 'models', models, selected: currentModel ? this.modelKey(currentModel) : undefined });
			this.postSlashCommands();
			await this.postSessionStatus(messages);
			this.log('Initialized chat panel', { modelCount: models.length, messageCount: messages.length, commandCount: commands.length, contextWindow: this.contextWindow });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log('Failed to initialize chat panel', { error: message });
			this.post({ type: 'error', message: `Unable to start Pi RPC: ${message}` });
		}
	}

	private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
		this.log('Received webview message', { type: message.type });
		switch (message.type) {
			case 'submit':
				await this.submitPrompt(message.text ?? '', message.includeIdeContext !== false);
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
				this.log(`Webview: ${message.message ?? ''}`, message.details);
				break;
		}
	}

	private async newChat(): Promise<void> {
		if (this.isStreaming) {
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
			await this.postSessionStatus([]);
			this.postIdeContext();
			void this.refreshSlashCommands();
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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
		const restoredToolCalls = new Map<string, { elementId: string; name?: string; args?: unknown }>();
		let firstUserMessage: string | undefined;
		for (const message of messages) {
			const restoredFirstUserMessage = this.restoreMessage(message, restoredToolCalls);
			firstUserMessage ??= restoredFirstUserMessage;
		}

		const title = session.name ? extractRestoredPrompt(session.name).text : firstUserMessage || 'New Chat';
		this.hasSessionTitle = Boolean(firstUserMessage || session.name);
		this.post({ type: 'sessionTitle', title: this.truncate(title, 50) });
		await this.postSessionStatus(messages);
		void this.refreshSlashCommands();
	}

	private resetConversationState(): void {
		this.activeThinkingMessageId = undefined;
		this.activeLoadingMessageId = undefined;
		this.activeToolCallIds.clear();
		this.activeToolCallArgs.clear();
		this.activeTextMessageIds.clear();
		this.hasSessionTitle = false;
		this.isStreaming = false;
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
			return;
		}

		if (!Array.isArray(content)) {
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

		const details = typeof record.details === 'object' && record.details !== null ? record.details as { diff?: unknown } : undefined;
		const diff = typeof details?.diff === 'string' ? details.diff : undefined;
		const isError = record.isError === true;
		this.post({
			type: 'upsertTool',
			id: toolCall?.elementId ?? this.createId('restored-tool'),
			toolName: name,
			path: getToolHeaderDetail(name, toolCall?.args),
			status: isError ? 'error' : 'done',
			body: name === 'read' && !isError ? undefined : diff ?? getToolResultText(message as RpcEvent['result']) ?? getToolBody(name, toolCall?.args),
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

	private async postSessionStatus(messages: unknown[]): Promise<void> {
		this.usageMessages = messages;
		this.activeUsageMessage = undefined;
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
			this.log('Failed to refresh slash commands', { error: error instanceof Error ? error.message : String(error) });
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
			this.log('Failed to load Pi builtin slash commands', { error: error instanceof Error ? error.message : String(error) });
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
				this.post({ type: 'error', message: `/${commandName} is a Pi TUI command and is not available in Crust yet.` });
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
		const messages = this.activeUsageMessage === undefined ? this.usageMessages : [...this.usageMessages, this.activeUsageMessage];
		this.post({ type: 'status', message: formatUsageStatus(messages, this.contextWindow) });
	}

	private postIdeContext(): void {
		const ideContext = getIdeContext(this.lastActiveTextEditor);
		this.post({ type: 'ideContext', label: ideContext?.label });
	}

	private async submitPrompt(text: string, includeIdeContext: boolean, display?: { text?: string; slashCommandLabel?: string }): Promise<void> {
		const trimmed = text.trim();
		const displayText = display?.text ?? trimmed;
		const ideContext = includeIdeContext ? getIdeContext(this.lastActiveTextEditor) : undefined;
		const promptText = ideContext ? buildPromptWithIdeContext(trimmed, ideContext) : trimmed;
		this.log('Submitting prompt', { length: trimmed.length, promptLength: promptText.length, followUp: this.isStreaming, ideContext: ideContext?.label, slashCommand: display?.slashCommandLabel });
		if (!trimmed) {
			return;
		}

		if (!this.hasSessionTitle) {
			this.setSessionTitleFromPrompt(display?.slashCommandLabel ?? displayText);
		}

		const userMessageId = this.createId('user');
		this.activeLoadingMessageId = this.createId('loading');
		this.activeTextMessageIds.clear();
		this.post({ type: 'addMessage', id: userMessageId, role: 'user', text: displayText, ideContextLabel: ideContext?.label, slashCommandLabel: display?.slashCommandLabel });
		this.post({ type: 'addMessage', id: this.activeLoadingMessageId, role: 'assistant', text: '', loading: true });
		this.activeUsageMessage = undefined;
		if (this.usageMessages.length) {
			this.postCurrentUsageStatus();
		}

		try {
			await this.client.prompt(promptText, this.isStreaming ? 'followUp' : undefined);
		} catch (error) {
			this.log('Prompt failed', { error: error instanceof Error ? error.message : String(error) });
			const assistantMessageId = this.getStreamingTextMessageId(0);
			this.post({ type: 'appendMessage', id: assistantMessageId, text: `\nError: ${error instanceof Error ? error.message : String(error)}` });
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
			this.contextWindow = this.getModelContextWindow(model);
			await this.postSessionStatus(await this.client.getMessages());
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private handlePiEvent(event: RpcEvent): void {
		this.log('Received Pi event', { type: event.type, assistantEventType: event.assistantMessageEvent?.type, toolName: event.toolName });
		if (event.type === 'agent_start') {
			this.isStreaming = true;
			this.activeThinkingMessageId = undefined;
			this.activeToolCallIds.clear();
			this.activeToolCallArgs.clear();
			this.activeTextMessageIds.clear();
			return;
		}

		if (event.type === 'agent_end') {
			this.isStreaming = false;
			this.activeThinkingMessageId = undefined;
			this.activeToolCallIds.clear();
			this.activeToolCallArgs.clear();
			this.activeTextMessageIds.clear();
			this.removeActiveLoadingMessage();
			void this.refreshUsageStatus();
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

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
			this.post({ type: 'appendMessage', id: this.getStreamingTextMessageId(assistantEvent.contentIndex ?? 0), text: assistantEvent.delta });
		}

		if (assistantEvent?.type === 'error') {
			this.post({ type: 'appendMessage', id: this.getStreamingTextMessageId(assistantEvent.contentIndex ?? 0), text: `\nError: ${assistantEvent.reason ?? 'unknown error'}` });
		}
	}

	private getStreamingTextMessageId(contentIndex: number): string {
		const existing = this.activeTextMessageIds.get(contentIndex);
		if (existing) {
			return existing;
		}

		const id = this.createId('assistant');
		this.activeTextMessageIds.set(contentIndex, id);
		this.post({ type: 'addMessage', id, role: 'assistant', text: '' });
		return id;
	}

	private removeActiveLoadingMessage(): void {
		if (!this.activeLoadingMessageId) {
			return;
		}
		this.post({ type: 'removeMessage', id: this.activeLoadingMessageId });
		this.activeLoadingMessageId = undefined;
	}

	private showToolExecutionStart(event: RpcEvent): void {
		if (!isRenderableTool(event.toolName)) {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.activeToolCallArgs.get(event.toolCallId) : undefined);
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

	private showToolExecutionUpdate(event: RpcEvent): void {
		if (!isRenderableTool(event.toolName) || event.toolName === 'read') {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.activeToolCallArgs.get(event.toolCallId) : undefined);
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: getToolHeaderDetail(event.toolName, args),
			status: 'running',
			body: getToolResultText(event.partialResult),
		});
	}

	private showToolExecutionEnd(event: RpcEvent): void {
		if (!isRenderableTool(event.toolName)) {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.activeToolCallArgs.get(event.toolCallId) : undefined);
		const diff = typeof event.result?.details?.diff === 'string' ? event.result.details.diff : undefined;
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: getToolHeaderDetail(event.toolName, args),
			status: event.isError ? 'error' : 'done',
			body: event.toolName === 'read' ? undefined : diff ?? getToolResultText(event.result) ?? getToolBody(event.toolName, args),
			isDiff: Boolean(diff),
		});
	}

	private showStreamingUsage(event: RpcEvent): void {
		if (event.message === undefined || !this.hasMessageUsage(event.message)) {
			return;
		}
		this.activeUsageMessage = event.message;
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

	private showStreamingThinking(event: RpcEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'thinking_start') {
			this.activeThinkingMessageId = undefined;
			return;
		}

		if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
			if (!this.activeThinkingMessageId) {
				this.activeThinkingMessageId = this.createId('thinking');
				this.post({ type: 'addThinking', id: this.activeThinkingMessageId });
			}
			this.post({ type: 'appendThinking', id: this.activeThinkingMessageId, text: assistantEvent.delta });
		}
	}

	private showStreamingToolCall(event: RpcEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (!assistantEvent?.type.startsWith('toolcall_')) {
			return;
		}

		const toolCall = this.extractToolCall(event);
		if (!isRenderableTool(toolCall.name)) {
			return;
		}

		if (toolCall.id && toolCall.args !== undefined) {
			this.activeToolCallArgs.set(toolCall.id, toolCall.args);
		}
		const contentIndex = assistantEvent.contentIndex ?? 0;
		const indexKey = `index:${contentIndex}`;
		const toolKey = toolCall.id ? `id:${toolCall.id}` : indexKey;
		const existingId = this.activeToolCallIds.get(toolKey) ?? this.activeToolCallIds.get(indexKey);
		const id = toolCall.id ? this.toolElementId(toolCall.id) : existingId ?? this.createId('toolcall');
		if (toolCall.id) {
			const temporaryId = this.activeToolCallIds.get(indexKey);
			if (temporaryId && temporaryId !== id) {
				this.post({ type: 'removeMessage', id: temporaryId });
			}
			this.activeToolCallIds.delete(indexKey);
		}
		this.activeToolCallIds.set(toolKey, id);
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

	private extractToolCall(event: RpcEvent): { id?: string; name?: string; args?: unknown } {
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

	private log(message: string, details?: unknown): void {
		const timestamp = new Date().toISOString();
		const suffix = details === undefined ? '' : ` ${this.stringifyLogDetails(details)}`;
		this.output.appendLine(`[${timestamp}] ${message}${suffix}`);
	}

	private stringifyLogDetails(details: unknown): string {
		try {
			return JSON.stringify(details);
		} catch {
			return String(details);
		}
	}

	private setSessionTitleFromPrompt(prompt: string): void {
		this.hasSessionTitle = true;
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

	private createId(prefix: string): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	private getIconPath(): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
		const icon = vscode.Uri.joinPath(this.context.extensionUri, 'branding', 'icon-small.svg');
		return { light: icon, dark: icon };
	}
}
