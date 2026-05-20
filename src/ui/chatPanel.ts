import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import { type Model, type RpcEvent, type SlashCommand } from '../pi/rpcTypes';
import { getCrustOutputChannel, logCrust, type CrustLogLevel } from '../utils/crustLogger';
import { errorMessage } from '../utils/errorMessage';
import { parseWebviewMessage, type SessionInfo } from './chatTypes';
import { getChatWebviewHtml } from './chatWebview';
import { buildPromptWithIdeContext, getIdeContext } from './ideContext';
import { getMessageRole, getMessageText } from './messageUtils';
import { createId, formatErrorForChat, formatSessionDate, getAbortMessage, getInitialCwd, getLastModelFromSessionText, getModelContextWindow, getSessionPath, getWorkspaceStatus, hasMessageUsage, isAbortedAssistantMessage, modelKey, truncate } from './chatPanelUtils';
import { createConversationState, resetStreamingState, type ConversationState } from './conversationState';
import { getPathSuggestions } from './pathAutocomplete';
import { listSessions } from './sessionHistory';
import { restoreSessionMessages } from './sessionRestoreRenderer';
import { getBuiltinSlashCommands, getPiChangelogMarkdown, isSupportedBuiltinSlashCommand, orderSlashCommands } from './slashCommands';
import { StreamingEventRenderer } from './streamingEventRenderer';
import { formatUsageStatus } from './usageStatus';

function getAllowRawHtmlSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.markdown').get<boolean>('allowRawHtml', false);
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
	private allowRawHtml = getAllowRawHtmlSetting();

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
		this.cwd = getInitialCwd();
		this.client = new PiRpcClient(this.cwd);
		this.log('Creating chat panel', { cwd: this.cwd });
		this.panel.iconPath = this.getIconPath();
		this.panel.webview.html = getChatWebviewHtml(this.context.extensionUri, this.panel.webview, { allowRawHtml: this.allowRawHtml });

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
			vscode.workspace.onDidChangeConfiguration((event) => this.handleConfigurationChange(event)),
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

	private async initialize(): Promise<void> {
		this.postMarkdownSettings();
		this.postIdeContext();
		try {
			this.log('Initializing Pi RPC client');
			await this.client.start();
			const [models, initialState, commands, builtinCommands] = await Promise.all([
				this.client.getAvailableModels(),
				this.client.getState(),
				this.client.getCommands(),
				getBuiltinSlashCommands((message, details, level) => this.log(message, details, level)),
			]);
			let state = initialState;
			if (this.restoredSessionPath && getSessionPath(state) !== this.restoredSessionPath) {
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
			this.contextWindow = getModelContextWindow(currentModel);
			const sessionPath = getSessionPath(state);
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
				if (message.level === 'warn' || message.level === 'error') {
					this.log(`Webview: ${message.message ?? ''}`, message.details, message.level);
				}
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
					label: session.name || truncate(session.firstMessage, 80),
					description: formatSessionDate(session.modified),
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
		const restored = restoreSessionMessages(messages, sessionName, (message) => this.post(message), (text) => this.getSlashCommandLabel(text));
		this.conversationState.hasSessionTitle = restored.hasSessionTitle;
		this.post({ type: 'sessionTitle', title: restored.title });
		await this.postSessionStatus(messages);
	}

	private resetConversationState(): void {
		const wasProcessing = this.conversationState.isProcessing;
		this.conversationState = createConversationState();
		if (wasProcessing) {
			this.post({ type: 'processing', processing: false });
		}
	}

	private async refreshUsageStatus(): Promise<void> {
		try {
			await this.postSessionStatus(await this.client.getMessages());
		} catch {
			// Usage is informational; avoid replacing a more useful status with an error.
		}
	}

	private finalizeUsageStatus(message: unknown): void {
		if (!hasMessageUsage(message)) {
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
			this.post({ type: 'status', message: await getWorkspaceStatus(this.cwd) });
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
		const commands = orderSlashCommands(this.builtinSlashCommands, this.piSlashCommands);
		this.log('Posting slash commands', {
			cwd: this.cwd,
			builtinCount: this.builtinSlashCommands.length,
			piCount: this.piSlashCommands.length,
			totalCount: commands.length,
			commandNames: commands.slice(0, 50).map((command) => command.name),
		});
		this.post({ type: 'slashCommands', commands });
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
		if (!isSupportedBuiltinSlashCommand(commandName)) {
			this.postError(`/${commandName} is a Pi TUI command and is not available in Crust yet.`);
			return;
		}

		switch (commandName) {
			case 'new':
				await this.newChat();
				return;
			case 'compact':
				await this.compactSession(commandText.trim() || '/compact', args || undefined);
				return;
			case 'clone':
				await this.cloneSession(commandText.trim() || '/clone');
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
			case 'copy':
				await this.copyLastAssistantMessage(commandText.trim() || '/copy');
				return;
			case 'changelog':
				await this.showChangelog(commandText.trim() || '/changelog');
				return;
			case 'reload':
				await this.reloadPiResources(commandText.trim() || '/reload');
				return;
			case 'quit':
				this.panel.dispose();
				return;
		}
	}

	private async reloadPiResources(invocation: string): Promise<void> {
		if (this.conversationState.isProcessing || this.conversationState.isStreaming) {
			void vscode.window.showInformationMessage('Wait for the current response to finish before reloading Pi resources.');
			return;
		}

		this.log('Reloading Pi resources by restarting RPC process');
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}

		const sessionPath = this.activeSessionPath;
		this.conversationState.activeLoadingMessageId = createId('loading');
		this.conversationState.activeTextMessageIds.clear();
		this.conversationState.activeAbortIndicatorShown = false;
		this.conversationState.activeErrorMessageShown = false;
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });
		this.post({ type: 'addMessage', id: this.conversationState.activeLoadingMessageId, role: 'assistant', text: '', loading: true });
		this.setProcessing(true);
		this.post({ type: 'status', message: 'Reloading Pi resources...' });

		try {
			await this.client.restart();
			const [models, state, commands, builtinCommands] = await Promise.all([
				this.client.getAvailableModels(),
				this.client.getState(),
				this.client.getCommands(),
				getBuiltinSlashCommands((message, details, level) => this.log(message, details, level)),
			]);
			let currentState = state;
			if (sessionPath && getSessionPath(state) !== sessionPath && await this.client.switchSession(sessionPath)) {
				currentState = await this.client.getState();
			}
			this.models = models;
			this.piSlashCommands = commands;
			this.builtinSlashCommands = builtinCommands;
			this.setCurrentModel((currentState as { model?: Model | null } | undefined)?.model ?? undefined);
			const currentSessionPath = getSessionPath(currentState);
			this.post({ type: 'sessionPath', sessionPath: currentSessionPath });
			this.watchSessionFile(currentSessionPath);
			this.postSlashCommands();
			await this.postSessionStatus(await this.client.getMessages());
			this.removeActiveLoadingMessage();
			this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: 'Reloaded Pi resources.', secondary: true });
		} catch (error) {
			this.removeActiveLoadingMessage();
			this.postError(errorMessage(error), { operation: 'reloadPiResources' });
		} finally {
			this.setProcessing(false);
			resetStreamingState(this.conversationState);
		}
	}

	private async cloneSession(invocation: string): Promise<void> {
		if (this.conversationState.isProcessing || this.conversationState.isStreaming) {
			void vscode.window.showInformationMessage('Wait for the current response to finish before cloning the session.');
			return;
		}

		this.log('Cloning current session');
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });
		this.setProcessing(true);
		this.post({ type: 'status', message: 'Cloning session...' });

		try {
			const cloned = await this.client.clone();
			if (!cloned) {
				this.post({ type: 'status', message: 'Clone cancelled.' });
				return;
			}

			this.resetConversationState();
			this.post({ type: 'clearMessages' });
			const messages = await this.client.getMessages();
			await this.restoreMessages(messages);
			await this.postCurrentSessionPath();
			this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: 'Cloned to new session.', secondary: true });
			void this.refreshCurrentModel();
			void this.refreshSlashCommands();
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'cloneSession' });
		} finally {
			this.setProcessing(false);
		}
	}

	private async copyLastAssistantMessage(invocation: string): Promise<void> {
		this.log('Copying last assistant message');
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });

		const messages = await this.client.getMessages();
		const text = messages
			.slice()
			.reverse()
			.map((message) => getMessageRole(message) === 'assistant' ? getMessageText(message) : '')
			.find((candidate) => candidate.trim().length > 0);

		if (!text) {
			this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: 'No agent message to copy.', secondary: true });
			return;
		}

		await vscode.env.clipboard.writeText(text);
		this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: 'Copied last agent message to clipboard.', secondary: true });
	}

	private async showChangelog(invocation: string): Promise<void> {
		this.log('Showing Pi changelog');
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });
		const changelog = await getPiChangelogMarkdown((message, details, level) => this.log(message, details, level));
		this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: `# What's New\n\n${changelog}`, secondary: true });
	}

	private async compactSession(invocation: string, customInstructions: string | undefined): Promise<void> {
		this.log('Compacting session', { customInstructions: Boolean(customInstructions) });
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}

		this.conversationState.activeLoadingMessageId = createId('loading');
		this.conversationState.activeTextMessageIds.clear();
		this.conversationState.activeAbortIndicatorShown = false;
		this.conversationState.activeErrorMessageShown = false;
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });
		this.post({ type: 'addMessage', id: this.conversationState.activeLoadingMessageId, role: 'assistant', text: '', loading: true });
		this.setProcessing(true);
		this.post({ type: 'status', message: 'Compacting context...' });

		try {
			const result = await this.client.compact(customInstructions);
			this.removeActiveLoadingMessage();
			this.postCompactionResult(result);
			await this.postSessionStatus(await this.client.getMessages());
			await this.postCurrentSessionPath();
		} catch (error) {
			this.removeActiveLoadingMessage();
			this.postError(errorMessage(error), { operation: 'compactSession' });
		} finally {
			this.setProcessing(false);
			resetStreamingState(this.conversationState);
			void this.refreshCurrentModel();
			void this.refreshSlashCommands();
		}
	}

	private postCompactionResult(result: unknown): void {
		const record = typeof result === 'object' && result !== null ? result as { summary?: unknown; tokensBefore?: unknown } : undefined;
		const summary = typeof record?.summary === 'string' ? record.summary.trim() : '';
		const tokensBefore = typeof record?.tokensBefore === 'number' && Number.isFinite(record.tokensBefore)
			? ` (${Math.round(record.tokensBefore / 1000)}k tokens summarized)`
			: '';
		const text = summary ? `Context compacted${tokensBefore}.\n\n${summary}` : `Context compacted${tokensBefore}.`;
		this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text, secondary: true, compaction: true });
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
			const sessionPath = getSessionPath(await this.client.getState());
			this.post({ type: 'sessionPath', sessionPath });
			this.watchSessionFile(sessionPath);
		} catch (error) {
			this.log('Failed to post current session path', { error: errorMessage(error) }, 'warn');
		}
	}

	private setCurrentModel(model: Model | undefined): void {
		const previousKey = this.currentModel ? modelKey(this.currentModel) : undefined;
		const nextKey = model ? modelKey(model) : undefined;
		this.currentModel = model;
		this.contextWindow = getModelContextWindow(model);
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
		if (this.currentModel && !models.some((model) => modelKey(model) === modelKey(this.currentModel!))) {
			models.push(this.currentModel);
		}
		this.post({ type: 'models', models, selected: this.currentModel ? modelKey(this.currentModel) : undefined });
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
			const model = getLastModelFromSessionText(text, this.models);
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

		const userMessageId = createId('user');
		this.conversationState.activeLoadingMessageId = createId('loading');
		this.conversationState.activeTextMessageIds.clear();
		this.conversationState.activeAbortIndicatorShown = false;
		this.conversationState.activeErrorMessageShown = false;
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
			this.post({ type: 'appendMessage', id: assistantMessageId, text: `\n${formatErrorForChat(message)}`, error: true });
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
			this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: trimmed });
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
			resetStreamingState(this.conversationState);
			this.removeActiveLoadingMessage();
		}
	}

	private async selectModel(selectedModelKey: string | undefined): Promise<void> {
		const model = this.models.find((candidate) => modelKey(candidate) === selectedModelKey);
		if (!model) {
			return;
		}

		try {
			await this.client.setModel(model);
			this.setCurrentModel(model);
			await this.postSessionStatus(await this.client.getMessages());
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'selectModel' });
		}
	}
	private handlePiEvent(event: RpcEvent): void {
		this.createStreamingEventRenderer().handlePiEvent(event);
	}

	private createStreamingEventRenderer(): StreamingEventRenderer {
		return new StreamingEventRenderer(this.conversationState, {
			post: (message) => this.post(message),
			setProcessing: (isProcessing) => this.setProcessing(isProcessing),
			setCurrentModel: (model) => this.setCurrentModel(model),
			finalizeUsageStatus: (message) => this.finalizeUsageStatus(message),
			postCurrentUsageStatus: () => this.postCurrentUsageStatus(),
			postCurrentSessionPath: () => { void this.postCurrentSessionPath(); },
			refreshCurrentModel: () => { void this.refreshCurrentModel(); },
		});
	}


	private getStreamingTextMessageId(contentIndex: number): string {
		const existing = this.conversationState.activeTextMessageIds.get(contentIndex);
		if (existing) {
			return existing;
		}
		const id = createId('assistant');
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

	private showAbortIndicator(message: unknown): void {
		if (this.conversationState.activeAbortIndicatorShown || !isAbortedAssistantMessage(message)) {
			return;
		}
		this.conversationState.activeAbortIndicatorShown = true;
		this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: `_${getAbortMessage(message)}_`, secondary: true });
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

	private handleConfigurationChange(event: vscode.ConfigurationChangeEvent): void {
		if (!event.affectsConfiguration('crust.markdown.allowRawHtml')) {
			return;
		}
		this.allowRawHtml = getAllowRawHtmlSetting();
		this.postMarkdownSettings();
	}

	private postMarkdownSettings(): void {
		this.post({ type: 'markdownSettings', allowRawHtml: this.allowRawHtml });
	}

	private post(message: unknown): void {
		void this.panel.webview.postMessage(message);
	}

	private postError(message: string, details?: unknown): void {
		this.log(message, details, 'error');
		this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: formatErrorForChat(message), error: true });
	}

	private log(message: string, details?: unknown, level: CrustLogLevel = 'info'): void {
		logCrust(message, details, level);
	}

	private setSessionTitleFromPrompt(prompt: string): void {
		this.conversationState.hasSessionTitle = true;
		const title = prompt.length > 50 ? `${prompt.slice(0, 47)}...` : prompt;
		this.post({ type: 'sessionTitle', title });
	}

private getIconPath(): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
		const icon = vscode.Uri.joinPath(this.context.extensionUri, 'branding', 'icon-small.svg');
		return { light: icon, dark: icon };
	}
}
