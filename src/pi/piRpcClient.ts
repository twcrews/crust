import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import { isRpcEvent, isRpcResponse, normalizeSlashCommand, type Model, type RpcEvent, type RpcResponse, type SlashCommand } from './rpcTypes';

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

export class PiRpcClient implements vscode.Disposable {
	private static readonly output = vscode.window.createOutputChannel('Crust Pi RPC');
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

		this.log('Starting Pi RPC process', { cwd: this.cwd });
		this.process = spawn('pi', ['--mode', 'rpc'], {
			cwd: this.cwd,
			env: process.env,
		});

		this.process.stdout.setEncoding('utf8');
		this.process.stderr.setEncoding('utf8');

		this.process.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
		this.process.stderr.on('data', (chunk: string) => {
			this.log('Pi RPC stderr', { message: chunk.trim() });
			this.errorEmitter.fire(chunk.trim());
		});
		this.process.on('error', (error) => {
			this.log('Pi RPC process error', { error: error.message });
			this.failAll(error);
		});
		this.process.on('exit', (code, signal) => {
			this.log('Pi RPC process exited', { code, signal });
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

	async getMessages(): Promise<unknown[]> {
		const response = await this.send({ type: 'get_messages' });
		const data = response.data as { messages?: unknown[] } | undefined;
		return Array.isArray(data?.messages) ? data.messages : [];
	}

	async getCommands(): Promise<SlashCommand[]> {
		const response = await this.send({ type: 'get_commands' });
		const data = response.data as { commands?: unknown[] } | undefined;
		return Array.isArray(data?.commands) ? data.commands.map(normalizeSlashCommand).filter(isDefined) : [];
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		const response = await this.send({ type: 'switch_session', sessionPath });
		const data = response.data as { cancelled?: boolean } | undefined;
		return !data?.cancelled;
	}

	async newSession(): Promise<boolean> {
		const response = await this.send({ type: 'new_session' });
		const data = response.data as { cancelled?: boolean } | undefined;
		return !data?.cancelled;
	}

	async compact(customInstructions?: string): Promise<void> {
		await this.send({ type: 'compact', ...(customInstructions ? { customInstructions } : {}) });
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: 'set_session_name', name });
	}

	async setModel(model: Model): Promise<void> {
		await this.send({ type: 'set_model', provider: model.provider, modelId: model.id });
	}

	async prompt(message: string, streamingBehavior?: 'followUp'): Promise<void> {
		await this.send({ type: 'prompt', message, ...(streamingBehavior ? { streamingBehavior } : {}) });
	}

	async steer(message: string): Promise<void> {
		await this.send({ type: 'steer', message });
	}

	async abort(): Promise<void> {
		await this.send({ type: 'abort' });
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
		this.log('Sending Pi RPC command', { id, type: command.type });
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

		this.log('Received Pi RPC response', { id, command: response.command, success: response.success });
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
				this.log('Received Pi RPC event', { type: message.type, assistantEventType: message.assistantMessageEvent?.type, toolName: message.toolName });
				this.eventEmitter.fire(message);
			}
		} catch (error) {
			this.log('Failed to parse Pi RPC output', { error: error instanceof Error ? error.message : String(error), line });
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

	private log(message: string, details?: unknown): void {
		const timestamp = new Date().toISOString();
		const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
		PiRpcClient.output.appendLine(`[${timestamp}] ${message}${suffix}`);
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}


function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
