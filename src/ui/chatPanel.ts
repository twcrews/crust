import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import type { Model, RpcEvent } from '../pi/rpcTypes';
import { getChatWebviewHtml } from './chatWebview';

type WebviewMessage = {
	type?: string;
	text?: string;
	modelKey?: string;
	message?: string;
	details?: unknown;
	includeIdeContext?: boolean;
};

type IdeContext = {
	label: string;
	filePath: string;
	languageId: string;
	selectionRange?: string;
	selectedText?: string;
};

type SessionInfo = {
	path: string;
	name?: string;
	firstMessage: string;
	modified: Date;
	messageCount: number;
};

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	contextTokens: number;
	cost: number;
};

const execFileAsync = promisify(execFile);

export class CrustChatPanel implements vscode.Disposable {
	private static currentPanel: CrustChatPanel | undefined;
	private readonly output = vscode.window.createOutputChannel('Crust');
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	private readonly client: PiRpcClient;
	private models: Model[] = [];
	private contextWindow: number | undefined;
	private isStreaming = false;
	private activeThinkingMessageId: string | undefined;
	private activeLoadingMessageId: string | undefined;
	private hasSessionTitle = false;
	private activeToolCallIds = new Map<number, string>();
	private activeToolCallArgs = new Map<string, unknown>();
	private activeTextMessageIds = new Map<number, string>();
	private lastActiveTextEditor = vscode.window.activeTextEditor;

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

	private async initialize(): Promise<void> {
		this.postIdeContext();
		try {
			this.log('Initializing Pi RPC client');
			await this.client.start();
			const [models, state, messages] = await Promise.all([
				this.client.getAvailableModels(),
				this.client.getState(),
				this.client.getMessages(),
			]);
			this.models = models;
			const currentModel = (state as { model?: Model | null } | undefined)?.model;
			this.contextWindow = this.getModelContextWindow(currentModel);
			this.post({ type: 'sessionTitle', title: 'New Chat' });
			this.post({ type: 'models', models, selected: currentModel ? this.modelKey(currentModel) : undefined });
			await this.postSessionStatus(messages);
			this.log('Initialized chat panel', { modelCount: models.length, messageCount: messages.length, contextWindow: this.contextWindow });
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
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async showHistory(): Promise<void> {
		try {
			this.log('Loading session history');
			const sessions = await this.listSessions();
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

		const title = session.name ? this.extractRestoredPrompt(session.name).text : firstUserMessage || 'New Chat';
		this.hasSessionTitle = Boolean(firstUserMessage || session.name);
		this.post({ type: 'sessionTitle', title: this.truncate(title, 50) });
		await this.postSessionStatus(messages);
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
		const role = this.getMessageRole(message);
		if (role === 'user') {
			const restoredPrompt = this.extractRestoredPrompt(this.getMessageText(message).trim());
			if (restoredPrompt.text) {
				this.post({
					type: 'addMessage',
					id: this.createId('user'),
					role: 'user',
					text: restoredPrompt.text,
					ideContextLabel: restoredPrompt.ideContextLabel,
				});
				return restoredPrompt.text;
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

		const text = this.getMessageText(message).trim();
		if (text) {
			this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text });
		}
		return undefined;
	}

	private restoreAssistantMessage(
		message: unknown,
		toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>,
	): void {
		const content = this.getMessageContent(message);
		if (typeof content === 'string') {
			this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text: content });
			return;
		}

		if (!Array.isArray(content)) {
			return;
		}

		for (const block of content) {
			const type = this.getBlockType(block);
			if (type === 'text') {
				const text = this.getBlockText(block, 'text').trim();
				if (text) {
					this.post({ type: 'addMessage', id: this.createId('assistant'), role: 'assistant', text });
				}
			}
			if (type === 'thinking') {
				const thinking = this.getBlockText(block, 'thinking');
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
		if (!this.isFileTool(name)) {
			return;
		}

		const elementId = this.createId('restored-tool');
		toolCalls.set(toolCallId, { elementId, name, args });
		this.post({
			type: 'upsertTool',
			id: elementId,
			toolName: name,
			path: this.getToolPath(args),
			status: 'pending',
			body: this.getToolBody(name, args),
			isDiff: name === 'edit',
		});
	}

	private restoreToolResult(message: unknown, toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>): void {
		const record = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
		const toolCall = typeof record.toolCallId === 'string' ? toolCalls.get(record.toolCallId) : undefined;
		const name = typeof record.toolName === 'string' ? record.toolName : toolCall?.name;
		if (!this.isFileTool(name)) {
			return;
		}

		const details = typeof record.details === 'object' && record.details !== null ? record.details as { diff?: unknown } : undefined;
		const diff = typeof details?.diff === 'string' ? details.diff : undefined;
		const isError = record.isError === true;
		this.post({
			type: 'upsertTool',
			id: toolCall?.elementId ?? this.createId('restored-tool'),
			toolName: name,
			path: this.getToolPath(toolCall?.args),
			status: isError ? 'error' : 'done',
			body: name === 'read' && !isError ? undefined : diff ?? this.getToolResultText(message as RpcEvent['result']) ?? this.getToolBody(name, toolCall?.args),
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
		if (!messages.length) {
			this.post({ type: 'status', message: await this.getWorkspaceStatus() });
			return;
		}
		this.postUsageStatus(messages);
	}

	private async getWorkspaceStatus(): Promise<string> {
		if (!this.cwd) {
			return 'No workspace folder';
		}

		const branch = await this.getGitBranch();
		return branch ? `${this.cwd} · ${branch}` : `${this.cwd} · no branch`;
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

	private postUsageStatus(messages: unknown[]): void {
		this.post({ type: 'status', message: this.formatUsageStats(this.getUsageStats(messages)) });
	}

	private getUsageStats(messages: unknown[]): UsageStats {
		const stats: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens: 0, cost: 0 };
		for (const message of messages) {
			const usage = this.getMessageUsage(message);
			if (!usage) {
				continue;
			}
			stats.input += this.getNumber(usage.input);
			stats.output += this.getNumber(usage.output);
			stats.cacheRead += this.getNumber(usage.cacheRead);
			stats.cacheWrite += this.getNumber(usage.cacheWrite);
			stats.contextTokens = this.getNumber(usage.totalTokens) || stats.contextTokens;
			stats.totalTokens += this.getNumber(usage.totalTokens);
			const cost = typeof usage.cost === 'object' && usage.cost !== null ? usage.cost as Record<string, unknown> : undefined;
			stats.cost += this.getNumber(cost?.total);
		}
		if (!stats.totalTokens) {
			stats.totalTokens = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
		}
		return stats;
	}

	private getMessageUsage(message: unknown): Record<string, unknown> | undefined {
		if (typeof message !== 'object' || message === null) {
			return undefined;
		}
		const record = message as { usage?: unknown; message?: unknown };
		const candidate = record.usage ?? (typeof record.message === 'object' && record.message !== null ? (record.message as { usage?: unknown }).usage : undefined);
		return typeof candidate === 'object' && candidate !== null ? candidate as Record<string, unknown> : undefined;
	}

	private formatUsageStats(stats: UsageStats): string {
		const parts = [
			`${this.formatTokenCount(stats.totalTokens)}`,
			`${this.formatTokenCount(stats.input)} in`,
			`${this.formatTokenCount(stats.output)} out`,
		];
		if (this.contextWindow) {
			parts.push(this.formatContextUsage(stats.contextTokens, this.contextWindow));
		}
		parts.push(this.formatCost(stats.cost));
		return `${parts.join(' · ')}`;
	}

	private formatContextUsage(usedTokens: number, availableTokens: number): string {
		const percent = availableTokens > 0 ? (usedTokens / availableTokens) * 100 : 0;
		return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)}%/${this.formatTokenCount(availableTokens)}`;
	}

	private formatTokenCount(value: number): string {
		const absolute = Math.abs(value);
		const units = [
			{ suffix: 'T', value: 1_000_000_000_000 },
			{ suffix: 'B', value: 1_000_000_000 },
			{ suffix: 'M', value: 1_000_000 },
			{ suffix: 'k', value: 1_000 },
		];
		const unit = units.find((candidate) => absolute >= candidate.value);
		if (!unit) {
			return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(value));
		}

		const scaled = value / unit.value;
		const maxFractionDigits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(scaled))) - 1);
		return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFractionDigits }).format(scaled)}${unit.suffix}`;
	}

	private formatCost(value: number): string {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
	}

	private getNumber(value: unknown): number {
		return typeof value === 'number' && Number.isFinite(value) ? value : 0;
	}

	private getMessageContent(message: unknown): unknown {
		return typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined;
	}

	private getBlockType(block: unknown): string | undefined {
		return typeof block === 'object' && block !== null && typeof (block as { type?: unknown }).type === 'string'
			? (block as { type: string }).type
			: undefined;
	}

	private getBlockText(block: unknown, key: 'text' | 'thinking'): string {
		return typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>)[key] === 'string'
			? (block as Record<string, string>)[key]
			: '';
	}

	private postIdeContext(): void {
		const ideContext = this.getIdeContext();
		this.post({ type: 'ideContext', label: ideContext?.label });
	}

	private getIdeContext(): IdeContext | undefined {
		const editor = this.lastActiveTextEditor;
		if (!editor) {
			return undefined;
		}

		const uri = editor.document.uri;
		if (uri.scheme !== 'file' && uri.scheme !== 'untitled') {
			return undefined;
		}

		const filePath = uri.scheme === 'file'
			? vscode.workspace.asRelativePath(uri, false)
			: editor.document.fileName;
		const fileName = basename(filePath) || filePath;
		const selection = editor.selection;
		if (selection && !selection.isEmpty) {
			const selectionRange = this.formatSelectionRange(selection);
			return {
				label: `${fileName}:${selectionRange}`,
				filePath,
				languageId: editor.document.languageId,
				selectionRange,
				selectedText: editor.document.getText(selection),
			};
		}

		return { label: fileName, filePath, languageId: editor.document.languageId };
	}

	private formatSelectionRange(selection: vscode.Selection): string {
		const startLine = selection.start.line + 1;
		const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
			? selection.end.line
			: selection.end.line + 1;
		return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
	}

	private buildPromptWithIdeContext(prompt: string, ideContext: IdeContext): string {
		const lines = [
			'<ide_context>',
			`Current file: ${ideContext.filePath}`,
		];
		if (ideContext.selectionRange && ideContext.selectedText !== undefined) {
			lines.push(
				`Selected lines: ${ideContext.selectionRange}`,
				'Selected text:',
				`\`\`\`${ideContext.languageId}`,
				ideContext.selectedText,
				'```',
			);
		}
		lines.push('</ide_context>', '', prompt);
		return lines.join('\n');
	}

	private extractRestoredPrompt(text: string): { text: string; ideContextLabel?: string } {
		const match = text.match(/^<ide_context>\n([\s\S]*?)\n<\/ide_context>\n*/);
		if (!match) {
			return { text };
		}

		const contextText = match[1];
		const filePath = contextText.match(/^Current file: (.+)$/m)?.[1]?.trim();
		const selectedLines = contextText.match(/^Selected lines: (.+)$/m)?.[1]?.trim();
		const fileName = filePath ? basename(filePath) : undefined;
		return {
			text: text.slice(match[0].length).trimStart(),
			ideContextLabel: fileName ? `${fileName}${selectedLines ? `:${selectedLines}` : ''}` : undefined,
		};
	}

	private async submitPrompt(text: string, includeIdeContext: boolean): Promise<void> {
		const trimmed = text.trim();
		const ideContext = includeIdeContext ? this.getIdeContext() : undefined;
		const promptText = ideContext ? this.buildPromptWithIdeContext(trimmed, ideContext) : trimmed;
		this.log('Submitting prompt', { length: trimmed.length, promptLength: promptText.length, followUp: this.isStreaming, ideContext: ideContext?.label });
		if (!trimmed) {
			return;
		}

		if (!this.hasSessionTitle) {
			this.setSessionTitleFromPrompt(trimmed);
		}

		const userMessageId = this.createId('user');
		this.activeLoadingMessageId = this.createId('loading');
		this.activeTextMessageIds.clear();
		this.post({ type: 'addMessage', id: userMessageId, role: 'user', text: trimmed, ideContextLabel: ideContext?.label });
		this.post({ type: 'addMessage', id: this.activeLoadingMessageId, role: 'assistant', text: '', loading: true });
		this.postUsageStatus([]);

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
		if (!this.isFileTool(event.toolName)) {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.activeToolCallArgs.get(event.toolCallId) : undefined);
		const id = this.toolElementId(event.toolCallId);
		this.post({
			type: 'upsertTool',
			id,
			toolName: event.toolName,
			path: this.getToolPath(args),
			status: 'running',
			body: this.getToolBody(event.toolName, args),
		});
	}

	private showToolExecutionUpdate(event: RpcEvent): void {
		if (!this.isFileTool(event.toolName) || event.toolName === 'read') {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.activeToolCallArgs.get(event.toolCallId) : undefined);
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: this.getToolPath(args),
			status: 'running',
			body: this.getToolResultText(event.partialResult),
		});
	}

	private showToolExecutionEnd(event: RpcEvent): void {
		if (!this.isFileTool(event.toolName)) {
			return;
		}

		const args = event.args ?? (event.toolCallId ? this.activeToolCallArgs.get(event.toolCallId) : undefined);
		const diff = typeof event.result?.details?.diff === 'string' ? event.result.details.diff : undefined;
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: this.getToolPath(args),
			status: event.isError ? 'error' : 'done',
			body: event.toolName === 'read' ? undefined : diff ?? this.getToolResultText(event.result) ?? this.getToolBody(event.toolName, args),
			isDiff: Boolean(diff),
		});
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
		if (!this.isFileTool(toolCall.name)) {
			return;
		}

		if (toolCall.id && toolCall.args !== undefined) {
			this.activeToolCallArgs.set(toolCall.id, toolCall.args);
		}
		const contentIndex = assistantEvent.contentIndex ?? 0;
		const existingId = this.activeToolCallIds.get(contentIndex);
		const id = toolCall.id ? this.toolElementId(toolCall.id) : existingId ?? this.createId('toolcall');
		if (toolCall.id && existingId && existingId !== id) {
			this.post({ type: 'removeMessage', id: existingId });
		}
		this.activeToolCallIds.set(contentIndex, id);
		this.post({
			type: 'upsertTool',
			id,
			toolName: toolCall.name,
			path: this.getToolPath(toolCall.args),
			status: assistantEvent.type === 'toolcall_end' ? 'pending' : 'drafting',
			body: this.getToolBody(toolCall.name, toolCall.args),
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

	private isFileTool(toolName: string | undefined): boolean {
		return toolName === 'read' || toolName === 'write' || toolName === 'edit';
	}

	private getToolPath(args: unknown): string | undefined {
		if (typeof args !== 'object' || args === null) {
			return undefined;
		}
		const path = (args as { path?: unknown; file_path?: unknown }).path ?? (args as { file_path?: unknown }).file_path;
		return typeof path === 'string' ? path : undefined;
	}

	private getToolBody(toolName: string | undefined, args: unknown): string | undefined {
		if (typeof args !== 'object' || args === null || toolName === 'read') {
			return undefined;
		}

		if (toolName === 'write') {
			const content = (args as { content?: unknown }).content;
			return typeof content === 'string' ? content : undefined;
		}

		if (toolName === 'edit') {
			return this.getEditPreview(args);
		}

		return undefined;
	}

	private getEditPreview(args: unknown): string | undefined {
		const edits = (args as { edits?: unknown }).edits;
		if (!Array.isArray(edits)) {
			return undefined;
		}
		return edits
			.map((edit, index) => {
				const oldText = typeof (edit as { oldText?: unknown }).oldText === 'string' ? (edit as { oldText: string }).oldText : '';
				const newText = typeof (edit as { newText?: unknown }).newText === 'string' ? (edit as { newText: string }).newText : '';
				return [`@@ edit ${index + 1} @@`, ...oldText.split('\n').map((line) => `-${line}`), ...newText.split('\n').map((line) => `+${line}`)].join('\n');
			})
			.join('\n');
	}

	private getToolResultText(result: RpcEvent['result']): string | undefined {
		const text = result?.content
			?.filter((content) => content.type === 'text')
			.map((content) => content.text ?? '')
			.join('\n')
			.trim();
		return text || undefined;
	}

	private toolElementId(toolCallId: string | undefined): string {
		return `tool-${toolCallId ?? this.createId('unknown')}`;
	}

	private async listSessions(): Promise<SessionInfo[]> {
		const sessionDir = await this.getSessionDir();
		if (!sessionDir || !existsSync(sessionDir)) {
			return [];
		}

		const entries = await readdir(sessionDir);
		const sessions = await Promise.all(
			entries
				.filter((entry) => entry.endsWith('.jsonl'))
				.map((entry) => this.readSessionInfo(join(sessionDir, entry))),
		);
		return sessions
			.filter((session): session is SessionInfo => Boolean(session))
			.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	private async getSessionDir(): Promise<string | undefined> {
		const state = await this.client.getState();
		const sessionFile = typeof (state as { sessionFile?: unknown } | undefined)?.sessionFile === 'string'
			? (state as { sessionFile: string }).sessionFile
			: undefined;
		if (sessionFile) {
			return dirname(sessionFile);
		}
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			return undefined;
		}
		const root = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions');
		return join(root, `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
	}

	private async readSessionInfo(path: string): Promise<SessionInfo | undefined> {
		try {
			const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
			const entries = content
				.trim()
				.split('\n')
				.map((line) => this.parseJsonObject(line))
				.filter((entry): entry is Record<string, unknown> => Boolean(entry));
			const header = entries[0];
			if (header?.type !== 'session') {
				return undefined;
			}

			let name: string | undefined;
			let firstMessage = '(no messages)';
			let messageCount = 0;
			let modified = stats.mtime;
			for (const entry of entries) {
				if (entry.type === 'session_info') {
					name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
				}
				if (entry.type !== 'message') {
					continue;
				}
				messageCount++;
				const message = entry.message;
				const role = this.getMessageRole(message);
				const text = this.getMessageText(message).trim();
				if (role === 'user' && firstMessage === '(no messages)' && text) {
					firstMessage = this.extractRestoredPrompt(text).text;
				}
				const timestamp = this.getMessageTimestamp(message) ?? this.getEntryTimestamp(entry);
				if (timestamp && timestamp > modified.getTime()) {
					modified = new Date(timestamp);
				}
			}

			return { path, name, firstMessage, modified, messageCount };
		} catch {
			return undefined;
		}
	}

	private parseJsonObject(line: string): Record<string, unknown> | undefined {
		try {
			const parsed = JSON.parse(line) as unknown;
			return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}

	private getMessageRole(message: unknown): 'user' | 'assistant' | string | undefined {
		return typeof message === 'object' && message !== null && typeof (message as { role?: unknown }).role === 'string'
			? (message as { role: string }).role
			: undefined;
	}

	private getMessageText(message: unknown): string {
		if (typeof message !== 'object' || message === null) {
			return '';
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === 'string') {
			return content;
		}
		if (!Array.isArray(content)) {
			return '';
		}
		return content
			.filter((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
			.map((block) => typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')
			.join('\n');
	}

	private getMessageTimestamp(message: unknown): number | undefined {
		if (typeof message !== 'object' || message === null || typeof (message as { timestamp?: unknown }).timestamp !== 'number') {
			return undefined;
		}
		return (message as { timestamp: number }).timestamp;
	}

	private getEntryTimestamp(entry: Record<string, unknown>): number | undefined {
		if (typeof entry.timestamp !== 'string') {
			return undefined;
		}
		const timestamp = new Date(entry.timestamp).getTime();
		return Number.isNaN(timestamp) ? undefined : timestamp;
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
