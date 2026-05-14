import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import type { Model, RpcEvent } from '../pi/rpcTypes';
import { getChatWebviewHtml } from './chatWebview';

type WebviewMessage = {
	type?: string;
	text?: string;
	modelKey?: string;
};

type SessionInfo = {
	path: string;
	name?: string;
	firstMessage: string;
	modified: Date;
	messageCount: number;
};

export class CrustChatPanel implements vscode.Disposable {
	private static currentPanel: CrustChatPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly client: PiRpcClient;
	private models: Model[] = [];
	private isStreaming = false;
	private activeAssistantMessageId: string | undefined;
	private activeThinkingMessageId: string | undefined;
	private hasSessionTitle = false;
	private activeToolCallIds = new Map<number, string>();

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
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.client = new PiRpcClient(cwd);
		this.panel.iconPath = this.getIconPath();
		this.panel.webview.html = getChatWebviewHtml(this.context.extensionUri, this.panel.webview);

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleWebviewMessage(message)),
			this.client.onEvent((event) => this.handlePiEvent(event)),
			this.client.onError((message) => this.post({ type: 'error', message })),
		);

		void this.initialize();
	}

	dispose(): void {
		CrustChatPanel.currentPanel = undefined;
		this.client.dispose();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private async initialize(): Promise<void> {
		try {
			await this.client.start();
			const [models, state] = await Promise.all([
				this.client.getAvailableModels(),
				this.client.getState(),
			]);
			this.models = models;
			const currentModel = (state as { model?: Model | null } | undefined)?.model;
			this.post({ type: 'sessionTitle', title: 'New Chat' });
			this.post({ type: 'models', models, selected: currentModel ? this.modelKey(currentModel) : undefined });
			this.post({ type: 'status', message: 'Connected to Pi.' });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.post({ type: 'error', message: `Unable to start Pi RPC: ${message}` });
		}
	}

	private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'submit':
				await this.submitPrompt(message.text ?? '');
				break;
			case 'selectModel':
				await this.selectModel(message.modelKey);
				break;
			case 'showHistory':
				await this.showHistory();
				break;
		}
	}

	private async showHistory(): Promise<void> {
		try {
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

			await this.restoreSession(selected.session);
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async restoreSession(session: SessionInfo): Promise<void> {
		const switched = await this.client.switchSession(session.path);
		if (!switched) {
			return;
		}

		this.activeAssistantMessageId = undefined;
		this.activeThinkingMessageId = undefined;
		this.activeToolCallIds.clear();
		this.hasSessionTitle = false;
		this.post({ type: 'clearMessages' });

		const messages = await this.client.getMessages();
		const restoredToolCalls = new Map<string, { elementId: string; name?: string; args?: unknown }>();
		let firstUserMessage: string | undefined;
		for (const message of messages) {
			const restoredFirstUserMessage = this.restoreMessage(message, restoredToolCalls);
			firstUserMessage ??= restoredFirstUserMessage;
		}

		const title = session.name || firstUserMessage || 'New Chat';
		this.hasSessionTitle = Boolean(firstUserMessage || session.name);
		this.post({ type: 'sessionTitle', title: this.truncate(title, 50) });
		this.post({ type: 'status', message: 'Session restored.' });
	}

	private restoreMessage(
		message: unknown,
		toolCalls: Map<string, { elementId: string; name?: string; args?: unknown }>,
	): string | undefined {
		const role = this.getMessageRole(message);
		if (role === 'user') {
			const text = this.getMessageText(message).trim();
			if (text) {
				this.post({ type: 'addMessage', id: this.createId('user'), role: 'user', text });
				return text;
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

	private async submitPrompt(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}

		if (!this.hasSessionTitle) {
			this.setSessionTitleFromPrompt(trimmed);
		}

		const userMessageId = this.createId('user');
		const assistantMessageId = this.createId('assistant');
		this.activeAssistantMessageId = assistantMessageId;
		this.post({ type: 'addMessage', id: userMessageId, role: 'user', text: trimmed });
		this.post({ type: 'addMessage', id: assistantMessageId, role: 'assistant', text: '', loading: true });

		try {
			await this.client.prompt(trimmed, this.isStreaming ? 'followUp' : undefined);
		} catch (error) {
			this.post({ type: 'appendMessage', id: assistantMessageId, text: `\nError: ${error instanceof Error ? error.message : String(error)}` });
		}
	}

	private async selectModel(modelKey: string | undefined): Promise<void> {
		const model = this.models.find((candidate) => this.modelKey(candidate) === modelKey);
		if (!model) {
			return;
		}

		try {
			await this.client.setModel(model);
			this.post({ type: 'status', message: `Model: ${this.modelLabel(model)}` });
		} catch (error) {
			this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private handlePiEvent(event: RpcEvent): void {
		if (event.type === 'agent_start') {
			this.isStreaming = true;
			this.activeThinkingMessageId = undefined;
			this.activeToolCallIds.clear();
			return;
		}

		if (event.type === 'agent_end') {
			this.isStreaming = false;
			this.activeAssistantMessageId = undefined;
			this.activeThinkingMessageId = undefined;
			this.activeToolCallIds.clear();
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

		if (!this.activeAssistantMessageId) {
			return;
		}

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
			this.post({ type: 'appendMessage', id: this.activeAssistantMessageId, text: assistantEvent.delta });
		}

		if (assistantEvent?.type === 'error') {
			this.post({ type: 'appendMessage', id: this.activeAssistantMessageId, text: `\nError: ${assistantEvent.reason ?? 'unknown error'}` });
		}
	}

	private showToolExecutionStart(event: RpcEvent): void {
		if (!this.isFileTool(event.toolName)) {
			return;
		}

		const id = this.toolElementId(event.toolCallId);
		this.post({
			type: 'upsertTool',
			id,
			toolName: event.toolName,
			path: this.getToolPath(event.args),
			status: 'running',
			body: this.getToolBody(event.toolName, event.args),
		});
	}

	private showToolExecutionUpdate(event: RpcEvent): void {
		if (!this.isFileTool(event.toolName) || event.toolName === 'read') {
			return;
		}

		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: this.getToolPath(event.args),
			status: 'running',
			body: this.getToolResultText(event.partialResult),
		});
	}

	private showToolExecutionEnd(event: RpcEvent): void {
		if (!this.isFileTool(event.toolName)) {
			return;
		}

		const diff = typeof event.result?.details?.diff === 'string' ? event.result.details.diff : undefined;
		this.post({
			type: 'upsertTool',
			id: this.toolElementId(event.toolCallId),
			toolName: event.toolName,
			path: this.getToolPath(event.args),
			status: event.isError ? 'error' : 'done',
			body: event.toolName === 'read' ? undefined : diff ?? this.getToolResultText(event.result) ?? this.getToolBody(event.toolName, event.args),
			isDiff: Boolean(diff),
		});
	}

	private showStreamingThinking(event: RpcEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'thinking_start') {
			this.activeThinkingMessageId = this.createId('thinking');
			this.post({ type: 'addThinking', id: this.activeThinkingMessageId });
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

		const contentIndex = assistantEvent.contentIndex ?? 0;
		const id = this.activeToolCallIds.get(contentIndex) ?? this.createId('toolcall');
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

	private extractToolCall(event: RpcEvent): { name?: string; args?: unknown } {
		const assistantEvent = event.assistantMessageEvent;
		const candidates = [
			assistantEvent?.toolCall,
			assistantEvent?.partial,
			this.getMessageContentAt(event.message, assistantEvent?.contentIndex),
		];
		const candidate = candidates.find((value) => typeof value === 'object' && value !== null);
		const record = candidate as { name?: unknown; toolName?: unknown; arguments?: unknown; args?: unknown } | undefined;
		return {
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
					firstMessage = text;
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
		void this.panel.webview.postMessage(message);
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

	private createId(prefix: string): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	private getIconPath(): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
		const icon = vscode.Uri.joinPath(this.context.extensionUri, 'branding', 'icon-small.svg');
		return { light: icon, dark: icon };
	}
}
