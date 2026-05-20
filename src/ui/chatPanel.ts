import { execFile } from 'node:child_process';
import { watch, type Dirent, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import { type Model, type RpcEvent, type SlashCommand } from '../pi/rpcTypes';
import { getCrustOutputChannel, logCrust, type CrustLogLevel } from '../utils/crustLogger';
import { errorMessage } from '../utils/errorMessage';
import { parseWebviewMessage, type SessionInfo } from './chatTypes';
import { getChatWebviewHtml } from './chatWebview';
import { buildPromptWithIdeContext, getIdeContext } from './ideContext';
import { getMessageRole, getMessageText } from './messageUtils';
import { createId, formatErrorForChat, formatSessionDate, getAbortMessage, getInitialCwd, getLastModelFromSessionText, getModelContextWindow, getPostLogDetails, getSessionPath, getWorkspaceStatus, hasMessageUsage, isAbortedAssistantMessage, modelKey, truncate } from './chatPanelUtils';
import { createConversationState, resetStreamingState, type ConversationState } from './conversationState';
import { getPathSuggestions } from './pathAutocomplete';
import { listSessions } from './sessionHistory';
import { restoreSessionMessages } from './sessionRestoreRenderer';
import { getBuiltinSlashCommands, getPiChangelogMarkdown, isSupportedBuiltinSlashCommand, orderSlashCommands } from './slashCommands';
import { StreamingEventRenderer } from './streamingEventRenderer';
import { formatUsageStatus } from './usageStatus';

const execFileAsync = promisify(execFile);

function getAllowRawHtmlSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.markdown').get<boolean>('allowRawHtml', false);
}

function getPiCommandPathSetting(): string {
	return vscode.workspace.getConfiguration('crust.pi').get<string>('commandPath', 'pi').trim() || 'pi';
}

function getIncludeIdeContextByDefaultSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.chat').get<boolean>('includeIdeContextByDefault', false);
}

function getLockEditorGroupOnOpenSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.chat').get<boolean>('lockEditorGroupOnOpen', true);
}

function getDefaultModelSetting(): string | undefined {
	const value = vscode.workspace.getConfiguration('crust.pi').get<string>('defaultModel', '').trim();
	return value || undefined;
}

function getRestoreOnReloadSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.session').get<boolean>('restoreOnReload', true);
}

function formatSessionInfo(state: unknown, stats: unknown, currentModel: Model | undefined): string {
	const stateRecord = asRecord(state);
	const statsRecord = asRecord(stats);
	const tokens = asRecord(statsRecord?.tokens);
	const contextUsage = asRecord(statsRecord?.contextUsage);
	const sessionPath = getString(statsRecord?.sessionFile) ?? getSessionPath(state);
	const sessionName = getString(stateRecord?.sessionName);
	const sessionId = getString(statsRecord?.sessionId) ?? getString(stateRecord?.sessionId);
	const stateModel = stateRecord?.model;
	const model = currentModel ?? (isModelLike(stateModel) ? stateModel : undefined);
	const contextTokens = getNullableNumber(contextUsage?.tokens);
	const contextWindow = getNumber(contextUsage?.contextWindow);
	const contextPercent = getNullableNumber(contextUsage?.percent);
	const lines = ['# Session', ''];

	if (sessionName) {
		lines.push(`- **Name:** ${sessionName}`);
	}
	if (sessionId) {
		lines.push(`- **ID:** \`${sessionId}\``);
	}
	if (sessionPath) {
		lines.push(`- **File:** \`${sessionPath}\``);
	}
	if (model) {
		lines.push(`- **Model:** ${model.name || model.id} (${model.provider}/${model.id})`);
	}

	lines.push(`- **Messages:** ${formatInteger(getNumber(statsRecord?.totalMessages) ?? getNumber(stateRecord?.messageCount) ?? 0)} total (${formatInteger(getNumber(statsRecord?.userMessages) ?? 0)} user, ${formatInteger(getNumber(statsRecord?.assistantMessages) ?? 0)} assistant, ${formatInteger(getNumber(statsRecord?.toolResults) ?? 0)} tool results)`);
	lines.push(`- **Tool calls:** ${formatInteger(getNumber(statsRecord?.toolCalls) ?? 0)}`);
	lines.push(`- **Tokens:** ${formatInteger(getNumber(tokens?.total) ?? 0)} total (${formatInteger(getNumber(tokens?.input) ?? 0)} input, ${formatInteger(getNumber(tokens?.output) ?? 0)} output, ${formatInteger(getNumber(tokens?.cacheRead) ?? 0)} cache read, ${formatInteger(getNumber(tokens?.cacheWrite) ?? 0)} cache write)`);
	if (contextWindow !== undefined) {
		const used = contextTokens === null || contextTokens === undefined ? 'unknown' : formatInteger(contextTokens);
		const percent = contextPercent === null || contextPercent === undefined ? '' : `, ${formatPercent(contextPercent)}`;
		lines.push(`- **Context:** ${used} / ${formatInteger(contextWindow)} tokens${percent}`);
	}
	lines.push(`- **Cost:** ${formatCurrency(getNumber(statsRecord?.cost) ?? 0)}`);

	return lines.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function getString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getNullableNumber(value: unknown): number | null | undefined {
	return value === null ? null : getNumber(value);
}

function isModelLike(value: unknown): value is Model {
	const record = asRecord(value);
	return Boolean(record && typeof record.id === 'string' && typeof record.provider === 'string');
}

function formatInteger(value: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatPercent(value: number): string {
	return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatCurrency(value: number): string {
	return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function getPathCommandArgument(text: string, command: string): string | undefined {
	if (text === command || !text.startsWith(`${command} `)) {
		return undefined;
	}
	const argsString = text.slice(command.length + 1).trimStart();
	if (!argsString) {
		return undefined;
	}
	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		return closingQuoteIndex < 0 ? undefined : argsString.slice(1, closingQuoteIndex);
	}
	const firstWhitespaceIndex = argsString.search(/\s/);
	return firstWhitespaceIndex < 0 ? argsString : argsString.slice(0, firstWhitespaceIndex);
}

export class CrustChatPanel implements vscode.Disposable {
	private static readonly viewType = 'crustChat';
	private static readonly openPanels = new Set<CrustChatPanel>();
	private static readonly onDidChangeOpenSessionsEmitter = new vscode.EventEmitter<void>();
	static readonly onDidChangeOpenSessions = CrustChatPanel.onDidChangeOpenSessionsEmitter.event;
	private static lastFocusedPanel: CrustChatPanel | undefined;
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
	private includeIdeContextByDefault = getIncludeIdeContextByDefaultSetting();
	private projectFilesByRoot = new Map<string, Set<string>>();

	static show(context: vscode.ExtensionContext): void {
		void CrustChatPanel.open(context);
	}

	static hasOpenPanel(): boolean {
		return this.openPanels.size > 0;
	}

	static getOpenSessionPaths(): Set<string> {
		return new Set([...this.openPanels].map((panel) => panel.activeSessionPath).filter((path): path is string => Boolean(path)));
	}

	static async openSession(context: vscode.ExtensionContext, sessionPath: string): Promise<void> {
		const alreadyOpenPanel = [...this.openPanels].find((panel) => panel.activeSessionPath === sessionPath);
		if (alreadyOpenPanel) {
			alreadyOpenPanel.panel.reveal(alreadyOpenPanel.panel.viewColumn ?? vscode.ViewColumn.Beside);
			alreadyOpenPanel.focusPrompt();
			return;
		}

		const panel = this.lastFocusedPanel ?? this.openPanels.values().next().value as CrustChatPanel | undefined;
		if (panel) {
			panel.panel.reveal(panel.panel.viewColumn ?? vscode.ViewColumn.Beside);
			await panel.restoreSessionPath(sessionPath);
			panel.focusPrompt();
			return;
		}
		await CrustChatPanel.open(context, sessionPath);
	}

	static registerSerializer(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerWebviewPanelSerializer(CrustChatPanel.viewType, {
			deserializeWebviewPanel: async (panel, state: unknown) => {
				panel.webview.options = { enableScripts: true };
				const shouldRestoreSession = getRestoreOnReloadSetting();
				const sessionPath = shouldRestoreSession && typeof (state as { sessionPath?: unknown } | undefined)?.sessionPath === 'string'
					? (state as { sessionPath: string }).sessionPath
					: undefined;
				new CrustChatPanel(context, panel, sessionPath);
			},
		});
	}

	private static async open(context: vscode.ExtensionContext, sessionPath?: string): Promise<void> {
		const panel = vscode.window.createWebviewPanel(
			CrustChatPanel.viewType,
			'Crust Chat',
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		const chatPanel = new CrustChatPanel(context, panel, sessionPath);
		if (getLockEditorGroupOnOpenSetting()) {
			await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
		}
		chatPanel.focusPrompt();
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
		private readonly restoredSessionPath?: string,
	) {
		this.cwd = getInitialCwd();
		this.client = new PiRpcClient(this.cwd, getPiCommandPathSetting());
		this.log('Creating chat panel', { cwd: this.cwd });
		this.panel.iconPath = this.getIconPath();
		this.panel.webview.html = getChatWebviewHtml(this.context.extensionUri, this.panel.webview, { allowRawHtml: this.allowRawHtml, includeIdeContextByDefault: this.includeIdeContextByDefault });

		CrustChatPanel.openPanels.add(this);
		CrustChatPanel.lastFocusedPanel = this;

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.onDidChangeViewState((event) => {
				if (event.webviewPanel.active) {
					CrustChatPanel.lastFocusedPanel = this;
				}
			}),
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
		CrustChatPanel.openPanels.delete(this);
		if (CrustChatPanel.lastFocusedPanel === this) {
			CrustChatPanel.lastFocusedPanel = CrustChatPanel.openPanels.values().next().value as CrustChatPanel | undefined;
		}
		CrustChatPanel.onDidChangeOpenSessionsEmitter.fire();
		this.client.dispose();
		this.disposeSessionWatcher();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private async initialize(): Promise<void> {
		this.postMarkdownSettings();
		this.postChatSettings();
		this.postIdeContext();
		try {
			await this.postProjectFiles();
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
			await this.applyDefaultModelSetting();
			this.contextWindow = getModelContextWindow(this.currentModel);
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
			case 'openProjectFile':
				await this.openProjectFile(message.path ?? '');
				break;
			case 'validateFileReferences':
				await this.validateFileReferences(message.requestId, message.references);
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

	private async postProjectFiles(): Promise<void> {
		const roots = this.getProjectRoots();
		const files = new Set<string>();
		const projectFilesByRoot = new Map<string, Set<string>>();
		await Promise.all(roots.map(async (root) => {
			const rootFiles = new Set(await this.listProjectFiles(root));
			projectFilesByRoot.set(root, rootFiles);
			for (const file of rootFiles) {
				files.add(file);
			}
		}));
		this.projectFilesByRoot = projectFilesByRoot;
		this.post({ type: 'projectFiles', files: [...files], roots });
	}

	private getProjectRoots(): string[] {
		const roots = [this.cwd, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)].filter((root): root is string => Boolean(root));
		return [...new Set(roots.map((root) => path.resolve(root)))];
	}

	private async listProjectFiles(root: string): Promise<string[]> {
		try {
			const [visible, ignored] = await Promise.all([
				execFileAsync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others'], { maxBuffer: 20 * 1024 * 1024 }),
				execFileAsync('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { maxBuffer: 20 * 1024 * 1024 }),
			]);
			return [...new Set(`${visible.stdout}\0${ignored.stdout}`.split('\0').filter(Boolean).map((file) => this.normalizeWebviewPath(file)))];
		} catch (error) {
			this.log('Falling back to filesystem walk for project file linkification', { root, error: errorMessage(error) }, 'warn');
			return this.walkProjectFiles(root);
		}
	}

	private async walkProjectFiles(root: string): Promise<string[]> {
		const files: string[] = [];
		const pending = [root];
		while (pending.length && files.length < 20000) {
			const directory = pending.pop();
			if (!directory) {
				continue;
			}
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const fullPath = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== '.git') {
						pending.push(fullPath);
					}
					continue;
				}
				if (entry.isFile()) {
					files.push(this.normalizeWebviewPath(path.relative(root, fullPath)));
				}
			}
		}
		return files;
	}

	private normalizeWebviewPath(filePath: string): string {
		return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
	}

	private async validateFileReferences(requestId: number, references: string[]): Promise<void> {
		const valid: string[] = [];
		const missing: string[] = [];
		await Promise.all([...new Set(references)].map(async (reference) => {
			const target = this.resolveFileReference(reference, false);
			if (!target) {
				missing.push(reference);
				return;
			}
			try {
				const stats = await stat(target.filePath);
				if (stats.isFile()) {
					valid.push(reference);
					return;
				}
			} catch {
				// Non-existing candidates are expected and should simply remain plain text.
			}
			missing.push(reference);
		}));
		this.post({ type: 'fileReferencesValidated', requestId, references: valid, missing });
	}

	private async openProjectFile(reference: string): Promise<void> {
		const target = this.resolveProjectFileReference(reference);
		if (!target) {
			return;
		}
		try {
			const stats = await stat(target.filePath);
			if (!stats.isFile()) {
				return;
			}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.filePath));
			const editor = await vscode.window.showTextDocument(document, { preview: true });
			if (target.line !== undefined) {
				const line = Math.min(Math.max(target.line - 1, 0), Math.max(document.lineCount - 1, 0));
				const character = Math.max((target.column ?? 1) - 1, 0);
				const position = new vscode.Position(line, Math.min(character, document.lineAt(line).text.length));
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
		} catch (error) {
			this.log('Failed to open project file reference', { reference, path: target.filePath, error: errorMessage(error) }, 'warn');
			void vscode.window.showWarningMessage(`Crust could not open ${reference}.`);
		}
	}

	private resolveProjectFileReference(reference: string): { filePath: string; line?: number; column?: number } | undefined {
		return this.resolveFileReference(reference, true);
	}

	private resolveFileReference(reference: string, requireIndexedProjectFile: boolean): { filePath: string; line?: number; column?: number } | undefined {
		let value = reference.trim().replace(/^@/, '');
		if (!value) {
			return undefined;
		}
		value = value.replace(/^`|`$/g, '').replace(/^["'<({[]+|["'>)}\],.;!?]+$/g, '');
		const location = value.match(/(?:[:#]L?)(\d+)(?::(\d+))?$/i);
		const line = location ? Number(location[1]) : undefined;
		const column = location?.[2] ? Number(location[2]) : undefined;
		if (location) {
			value = value.slice(0, location.index);
		}
		if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
			return undefined;
		}

		if (path.isAbsolute(value)) {
			return { filePath: path.resolve(value), line, column };
		}

		const roots = this.getProjectRoots();
		for (const root of roots) {
			const filePath = path.resolve(root, value.replace(/^~\//, ''));
			const relative = this.normalizeWebviewPath(path.relative(root, filePath));
			if (!requireIndexedProjectFile || this.projectFilesByRoot.get(root)?.has(relative)) {
				return { filePath, line, column };
			}
		}
		return undefined;
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

	private async restoreSessionPath(sessionPath: string): Promise<void> {
		await this.restoreSession({ path: sessionPath, firstMessage: '', modified: new Date(), messageCount: 0 });
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
			case 'export':
				await this.exportSession(commandText.trim() || '/export');
				return;
			case 'name':
				await this.client.setSessionName(args);
				this.post({ type: 'sessionTitle', title: args || 'New Chat' });
				return;
			case 'session':
				await this.showSessionInfo(commandText.trim() || '/session');
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

	private async exportSession(invocation: string): Promise<void> {
		this.log('Exporting session to HTML');
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });

		const outputPath = getPathCommandArgument(invocation, '/export');
		if (outputPath?.endsWith('.jsonl')) {
			this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: 'Crust currently supports `/export` for HTML only. JSONL export is not exposed by Pi RPC yet.', secondary: true });
			return;
		}

		try {
			const exportedPath = await this.client.exportHtml(outputPath);
			this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: `Session exported to: \`${exportedPath || outputPath || 'session.html'}\``, secondary: true });
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'exportSession' });
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

	private async showSessionInfo(invocation: string): Promise<void> {
		this.log('Showing session info');
		if (!this.conversationState.hasSessionTitle) {
			this.setSessionTitleFromPrompt(invocation);
		}
		this.post({ type: 'addMessage', id: createId('user'), role: 'user', text: '', slashCommandLabel: invocation });

		try {
			const [state, stats] = await Promise.all([this.client.getState(), this.client.getSessionStats()]);
			this.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: formatSessionInfo(state, stats, this.currentModel), secondary: true });
		} catch (error) {
			this.postError(errorMessage(error), { operation: 'showSessionInfo' });
		}
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
		CrustChatPanel.onDidChangeOpenSessionsEmitter.fire();
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

		await this.selectModelCandidate(model, 'selectModel');
	}

	private async applyDefaultModelSetting(): Promise<void> {
		const defaultModelKey = getDefaultModelSetting();
		if (!defaultModelKey || this.currentModel && modelKey(this.currentModel) === defaultModelKey) {
			return;
		}
		const model = this.models.find((candidate) => modelKey(candidate) === defaultModelKey);
		if (!model) {
			this.log('Configured default model is unavailable', { defaultModelKey }, 'warn');
			return;
		}
		await this.selectModelCandidate(model, 'applyDefaultModel');
	}

	private async selectModelCandidate(model: Model, operation: string): Promise<void> {
		try {
			await this.client.setModel(model);
			this.setCurrentModel(model);
			await this.postSessionStatus(await this.client.getMessages());
		} catch (error) {
			this.postError(errorMessage(error), { operation });
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
		if (event.affectsConfiguration('crust.markdown.allowRawHtml')) {
			this.allowRawHtml = getAllowRawHtmlSetting();
			this.postMarkdownSettings();
		}
		if (event.affectsConfiguration('crust.chat.includeIdeContextByDefault')) {
			this.includeIdeContextByDefault = getIncludeIdeContextByDefaultSetting();
			this.postChatSettings();
		}
		if (event.affectsConfiguration('crust.pi.commandPath')) {
			void this.client.setCommandPath(getPiCommandPathSetting()).then(
				() => this.post({ type: 'status', message: 'Pi command path updated.' }),
				(error: unknown) => this.postError(errorMessage(error), { operation: 'setCommandPath' }),
			);
		}
		if (event.affectsConfiguration('crust.pi.defaultModel')) {
			void this.applyDefaultModelSetting();
		}
	}

	private postMarkdownSettings(): void {
		this.post({ type: 'markdownSettings', allowRawHtml: this.allowRawHtml });
	}

	private postChatSettings(): void {
		this.post({ type: 'chatSettings', includeIdeContextByDefault: this.includeIdeContextByDefault });
	}

	private post(message: unknown): void {
		this.log('Posting webview message', getPostLogDetails(message));
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
