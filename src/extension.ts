import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';

type RpcResponse = {
	id?: string;
	type: 'response';
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type RpcEvent = {
	type: string;
	message?: unknown;
	assistantMessageEvent?: {
		type: string;
		delta?: string;
		reason?: string;
	};
};

type Model = {
	id: string;
	name?: string;
	provider: string;
};

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

class PiRpcClient implements vscode.Disposable {
	private process: ChildProcessWithoutNullStreams | undefined;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventEmitter = new vscode.EventEmitter<RpcEvent>();
	private readonly errorEmitter = new vscode.EventEmitter<string>();

	readonly onEvent = this.eventEmitter.event;
	readonly onError = this.errorEmitter.event;

	constructor(private readonly cwd: string | undefined) {}

	async start(): Promise<void> {
		if (this.process) {
			return;
		}

		this.process = spawn('pi', ['--mode', 'rpc'], {
			cwd: this.cwd,
			env: process.env,
		});

		this.process.stdout.setEncoding('utf8');
		this.process.stderr.setEncoding('utf8');

		this.process.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
		this.process.stderr.on('data', (chunk: string) => this.errorEmitter.fire(chunk.trim()));
		this.process.on('error', (error) => this.failAll(error));
		this.process.on('exit', (code, signal) => {
			this.errorEmitter.fire(`Pi exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`);
			this.process = undefined;
			this.failAll(new Error('Pi RPC process exited.'));
		});
	}

	async getState(): Promise<unknown> {
		const response = await this.send({ type: 'get_state' });
		return response.data;
	}

	async getAvailableModels(): Promise<Model[]> {
		const response = await this.send({ type: 'get_available_models' });
		const data = response.data as { models?: Model[] } | undefined;
		return Array.isArray(data?.models) ? data.models : [];
	}

	async setModel(model: Model): Promise<void> {
		await this.send({ type: 'set_model', provider: model.provider, modelId: model.id });
	}

	async prompt(message: string, streamingBehavior?: 'followUp'): Promise<void> {
		await this.send({ type: 'prompt', message, ...(streamingBehavior ? { streamingBehavior } : {}) });
	}

	dispose(): void {
		this.eventEmitter.dispose();
		this.errorEmitter.dispose();
		this.failAll(new Error('Pi RPC client disposed.'));
		this.process?.kill();
		this.process = undefined;
	}

	private async send(command: Record<string, unknown>): Promise<RpcResponse> {
		await this.start();

		if (!this.process) {
			throw new Error('Pi RPC process is not running.');
		}

		const id = `crust-${this.nextId++}`;
		const payload = JSON.stringify({ id, ...command });
		const response = await new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.process?.stdin.write(`${payload}\n`, (error) => {
				if (error) {
					this.pending.delete(id);
					reject(error);
				}
			});
		});

		if (!response.success) {
			throw new Error(response.error ?? `${response.command} failed`);
		}
		return response;
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;

		let newlineIndex = this.buffer.indexOf('\n');
		while (newlineIndex !== -1) {
			let line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.endsWith('\r')) {
				line = line.slice(0, -1);
			}
			this.handleLine(line);
			newlineIndex = this.buffer.indexOf('\n');
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) {
			return;
		}

		try {
			const message = JSON.parse(line) as unknown;
			if (isRpcResponse(message)) {
				this.handleResponse(message);
			} else if (isRpcEvent(message)) {
				this.eventEmitter.fire(message);
			}
		} catch (error) {
			this.errorEmitter.fire(`Failed to parse Pi RPC output: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private handleResponse(response: RpcResponse): void {
		if (!response.id) {
			return;
		}

		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}

		this.pending.delete(response.id);
		pending.resolve(response);
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

class CrustChatPanel implements vscode.Disposable {
	private static currentPanel: CrustChatPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly client: PiRpcClient;
	private models: Model[] = [];
	private isStreaming = false;
	private activeAssistantMessageId: string | undefined;

	static show(context: vscode.ExtensionContext): void {
		if (CrustChatPanel.currentPanel) {
			CrustChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'crustChat',
			'Crust Chat',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		CrustChatPanel.currentPanel = new CrustChatPanel(context, panel);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
	) {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.client = new PiRpcClient(cwd);
		this.panel.webview.html = this.getHtml();

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)),
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
			this.post({ type: 'models', models, selected: currentModel ? this.modelKey(currentModel) : undefined });
			this.post({ type: 'status', message: 'Connected to Pi.' });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.post({ type: 'error', message: `Unable to start Pi RPC: ${message}` });
		}
	}

	private async handleWebviewMessage(message: { type?: string; text?: string; modelKey?: string }): Promise<void> {
		switch (message.type) {
			case 'submit':
				await this.submitPrompt(message.text ?? '');
				break;
			case 'selectModel':
				await this.selectModel(message.modelKey);
				break;
		}
	}

	private async submitPrompt(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}

		const userMessageId = this.createId('user');
		const assistantMessageId = this.createId('assistant');
		this.activeAssistantMessageId = assistantMessageId;
		this.post({ type: 'addMessage', id: userMessageId, role: 'user', text: trimmed });
		this.post({ type: 'addMessage', id: assistantMessageId, role: 'assistant', text: '' });

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
			return;
		}

		if (event.type === 'agent_end') {
			this.isStreaming = false;
			this.activeAssistantMessageId = undefined;
			return;
		}

		if (event.type !== 'message_update' || !this.activeAssistantMessageId) {
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

	private post(message: unknown): void {
		void this.panel.webview.postMessage(message);
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

	private getHtml(): string {
		const nonce = getNonce();
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Crust Chat</title>
	<style>
		:root { color-scheme: light dark; }
		body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		.app { height: 100vh; display: flex; flex-direction: column; }
		.messages { flex: 1; overflow-y: auto; padding: 16px; padding-bottom: 8px; }
		.message { max-width: 900px; margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; line-height: 1.45; }
		.user { margin-left: auto; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.assistant { margin-right: auto; background: var(--vscode-editor-inactiveSelectionBackground); }
		.controls { border-top: 1px solid var(--vscode-panel-border); padding: 10px; background: var(--vscode-editor-background); }
		.input-row { display: flex; gap: 8px; align-items: stretch; }
		textarea { flex: 1; resize: vertical; min-height: 64px; max-height: 180px; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); font-family: var(--vscode-font-family); }
		button { padding: 0 16px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		select { width: 100%; margin-top: 8px; padding: 6px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
		.status { min-height: 18px; margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
		.error { color: var(--vscode-errorForeground); }
	</style>
</head>
<body>
	<div class="app">
		<main id="messages" class="messages" aria-live="polite"></main>
		<form id="form" class="controls">
			<div class="input-row">
				<textarea id="prompt" placeholder="Ask Pi…"></textarea>
				<button type="submit">Submit</button>
			</div>
			<select id="model" aria-label="Model"><option value="">Loading models…</option></select>
			<div id="status" class="status"></div>
		</form>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messages = document.getElementById('messages');
		const form = document.getElementById('form');
		const prompt = document.getElementById('prompt');
		const model = document.getElementById('model');
		const status = document.getElementById('status');

		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const text = prompt.value;
			if (!text.trim()) return;
			prompt.value = '';
			vscode.postMessage({ type: 'submit', text });
		});

		prompt.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				form.requestSubmit();
			}
		});

		model.addEventListener('change', () => {
			vscode.postMessage({ type: 'selectModel', modelKey: model.value });
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'models') setModels(message.models ?? [], message.selected);
			if (message.type === 'status') setStatus(message.message ?? '', false);
			if (message.type === 'error') setStatus(message.message ?? '', true);
			if (message.type === 'addMessage') addMessage(message.id, message.role, message.text ?? '');
			if (message.type === 'appendMessage') appendMessage(message.id, message.text ?? '');
		});

		function setModels(models, selected) {
			model.textContent = '';
			if (!models.length) {
				const option = document.createElement('option');
				option.value = '';
				option.textContent = 'No configured models found';
				model.append(option);
				return;
			}
			for (const candidate of models) {
				const option = document.createElement('option');
				option.value = candidate.provider + '/' + candidate.id;
				option.textContent = (candidate.name || candidate.id) + ' (' + candidate.provider + ')';
				model.append(option);
			}
			if (selected) model.value = selected;
		}

		function addMessage(id, role, text) {
			const element = document.createElement('div');
			element.id = id;
			element.className = 'message ' + role;
			element.textContent = text;
			messages.append(element);
			scrollToBottom();
		}

		function appendMessage(id, text) {
			const element = document.getElementById(id);
			if (!element) return;
			element.textContent += text;
			scrollToBottom();
		}

		function setStatus(message, isError) {
			status.textContent = message;
			status.className = 'status' + (isError ? ' error' : '');
		}

		function scrollToBottom() {
			messages.scrollTop = messages.scrollHeight;
		}
	</script>
</body>
</html>`;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('crust.openChat', () => CrustChatPanel.show(context)),
	);
}

export function deactivate(): void {}

function isRpcResponse(message: unknown): message is RpcResponse {
	return typeof message === 'object'
		&& message !== null
		&& (message as { type?: unknown }).type === 'response'
		&& typeof (message as { command?: unknown }).command === 'string'
		&& typeof (message as { success?: unknown }).success === 'boolean';
}

function isRpcEvent(message: unknown): message is RpcEvent {
	return typeof message === 'object'
		&& message !== null
		&& typeof (message as { type?: unknown }).type === 'string';
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
