import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { getIdeContext } from './ideContext';

function getPiCommandPathSetting(): string {
	return vscode.workspace.getConfiguration('crust.pi').get<string>('commandPath', 'pi').trim() || 'pi';
}

function getDefaultModelSetting(): string | undefined {
	const value = vscode.workspace.getConfiguration('crust.pi').get<string>('defaultModel', '').trim();
	return value || undefined;
}

function getIncludeIdeContextByDefaultSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.chat').get<boolean>('includeIdeContextByDefault', false);
}

function getRestoreOnReloadSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.session').get<boolean>('restoreOnReload', true);
}

function getLockEditorGroupOnOpenSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.chat').get<boolean>('lockEditorGroupOnOpen', true);
}

export function getUseTerminalViewByDefaultSetting(): boolean {
	return vscode.workspace.getConfiguration('crust.chat').get<boolean>('useTerminalViewByDefault', false);
}

const terminalSessionsKey = 'crust.terminalSessions';

type TerminalSessionMap = Record<string, string>;

export class CrustTerminalView {
	private static contextFile: string | undefined;
	private static lastActiveTextEditor: vscode.TextEditor | undefined;
	private static listenersRegistered = false;
	private static bridgeServer: Server | undefined;
	private static bridgeUrl: string | undefined;
	private static bridgeToken: string | undefined;
	private static terminalIds = new WeakMap<vscode.Terminal, string>();
	private static terminalsById = new Map<string, vscode.Terminal>();
	private static sessionFilesByTerminalId = new Map<string, string>();
	private static lastFocusedTerminalId: string | undefined;
	private static readonly onDidChangeOpenSessionsEmitter = new vscode.EventEmitter<void>();
	static readonly onDidChangeOpenSessions = CrustTerminalView.onDidChangeOpenSessionsEmitter.event;

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		this.lastActiveTextEditor = this.getCurrentTextEditor();
		this.contextFile = join(context.globalStorageUri.fsPath, 'terminal-ide-context.json');
		void this.writeIdeContext();

		void this.ensureBridge(context);
		if (getUseTerminalViewByDefaultSetting() && getRestoreOnReloadSetting()) {
			void this.restore(context);
		}

		const disposables = [
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (this.isIdeContextEditor(editor)) {
					this.lastActiveTextEditor = editor;
					void this.writeIdeContext();
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				if (this.isIdeContextEditor(event.textEditor)) {
					this.lastActiveTextEditor = event.textEditor;
					void this.writeIdeContext();
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.lastActiveTextEditor?.document === event.document) {
					void this.writeIdeContext();
				}
			}),
			vscode.window.onDidCloseTerminal((terminal) => this.onDidCloseTerminal(context, terminal)),
			vscode.window.onDidChangeActiveTerminal((terminal) => this.onDidChangeActiveTerminal(terminal)),
			new vscode.Disposable(() => this.bridgeServer?.close()),
		];
		this.listenersRegistered = true;
		return vscode.Disposable.from(...disposables);
	}

	static async show(context: vscode.ExtensionContext, sessionFile?: string): Promise<void> {
		if (!this.listenersRegistered) {
			context.subscriptions.push(this.register(context));
		}
		await this.writeIdeContext();

		await this.ensureBridge(context);
		const terminalId = randomUUID();
		const args = this.buildPiArgs(context, sessionFile);
		const terminal = this.createTerminal(context, terminalId, args);
		this.terminalIds.set(terminal, terminalId);
		this.terminalsById.set(terminalId, terminal);
		await this.updateSession(context, terminalId, sessionFile || '');
		terminal.show();
		await this.lockEditorGroupIfEnabled();
	}

	private static createTerminal(context: vscode.ExtensionContext, terminalId: string, args: string[]): vscode.Terminal {
		return vscode.window.createTerminal({
			name: 'Crust',
			shellPath: getPiCommandPathSetting(),
			shellArgs: args,
			location: { viewColumn: vscode.ViewColumn.Active },
			isTransient: false,
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			env: this.contextFile ? {
				CRUST_IDE_CONTEXT_FILE: this.contextFile,
				CRUST_IDE_CONTEXT_ENABLED: getIncludeIdeContextByDefaultSetting() ? '1' : '0',
				CRUST_TERMINAL_ID: terminalId,
				...(this.bridgeUrl && this.bridgeToken ? { CRUST_BRIDGE_URL: this.bridgeUrl, CRUST_BRIDGE_TOKEN: this.bridgeToken } : {}),
			} : undefined,
			iconPath: vscode.Uri.joinPath(context.extensionUri, 'branding', 'icon-small.svg'),
		});
	}

	private static buildPiArgs(context: vscode.ExtensionContext, sessionFile?: string): string[] {
		const args = [
			'--extension',
			vscode.Uri.joinPath(context.extensionUri, 'resources', 'pi', 'crust-vscode-context.js').fsPath,
			'--append-system-prompt',
			[
				'You are running inside VS Code via Crust terminal mode.',
				'Crust injects the current VS Code editor context before each agent turn when available.',
			].join('\n\n'),
		];
		if (sessionFile) {
			args.push('--session', sessionFile);
		}
		const model = getDefaultModelSetting();
		if (model) {
			args.push('--model', model);
		}
		return args;
	}

	private static async ensureBridge(context: vscode.ExtensionContext): Promise<void> {
		if (this.bridgeServer && this.bridgeUrl && this.bridgeToken) {
			return;
		}
		this.bridgeToken = randomUUID();
		this.bridgeServer = createServer((request, response) => {
			if (request.method !== 'POST' || request.url !== '/terminal-session' || request.headers.authorization !== `Bearer ${this.bridgeToken}`) {
				response.writeHead(404).end();
				return;
			}
			let body = '';
			request.setEncoding('utf8');
			request.on('data', (chunk: string) => {
				body += chunk;
				if (body.length > 8192) {
					request.destroy();
				}
			});
			request.on('end', () => {
				try {
					const payload = JSON.parse(body) as { terminalId?: unknown; sessionFile?: unknown };
					if (typeof payload.terminalId === 'string' && typeof payload.sessionFile === 'string') {
						void this.updateSession(context, payload.terminalId, payload.sessionFile);
					}
					response.writeHead(204).end();
				} catch {
					response.writeHead(400).end();
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.bridgeServer?.once('error', reject);
			this.bridgeServer?.listen(0, '127.0.0.1', () => resolve());
		});
		const address = this.bridgeServer.address();
		if (typeof address === 'object' && address) {
			this.bridgeUrl = `http://127.0.0.1:${address.port}`;
		}
	}

	static getOpenSessionPaths(): Set<string> {
		return new Set([...this.sessionFilesByTerminalId.values()].filter((path) => Boolean(path)));
	}

	static focusSession(sessionFile: string): boolean {
		const terminalId = [...this.sessionFilesByTerminalId.entries()].find(([, path]) => path === sessionFile)?.[0];
		const terminal = terminalId ? this.terminalsById.get(terminalId) : undefined;
		if (!terminal) {
			return false;
		}
		terminal.show();
		this.lastFocusedTerminalId = terminalId;
		return true;
	}

	static hasOpenTerminal(): boolean {
		return this.terminalsById.size > 0;
	}

	static async replaceSession(context: vscode.ExtensionContext, sessionFile: string): Promise<void> {
		const terminalId = this.lastFocusedTerminalId && this.terminalsById.has(this.lastFocusedTerminalId)
			? this.lastFocusedTerminalId
			: this.terminalsById.keys().next().value as string | undefined;
		if (!terminalId) {
			await this.show(context, sessionFile);
			return;
		}

		const previousTerminal = this.terminalsById.get(terminalId);
		previousTerminal?.show();
		await this.show(context, sessionFile);
		previousTerminal?.dispose();
		await this.removeSession(context, terminalId);
	}

	private static async updateSession(context: vscode.ExtensionContext, terminalId: string, sessionFile: string): Promise<void> {
		const sessions = context.workspaceState.get<TerminalSessionMap>(terminalSessionsKey, {});
		this.sessionFilesByTerminalId.set(terminalId, sessionFile);
		this.onDidChangeOpenSessionsEmitter.fire();
		await context.workspaceState.update(terminalSessionsKey, { ...sessions, [terminalId]: sessionFile });
	}

	private static onDidChangeActiveTerminal(terminal: vscode.Terminal | undefined): void {
		if (!terminal) {
			return;
		}
		const terminalId = this.terminalIds.get(terminal);
		if (terminalId) {
			this.lastFocusedTerminalId = terminalId;
		}
	}

	private static onDidCloseTerminal(context: vscode.ExtensionContext, terminal: vscode.Terminal): void {
		const terminalId = this.terminalIds.get(terminal);
		if (!terminalId) {
			return;
		}
		this.terminalsById.delete(terminalId);
		this.sessionFilesByTerminalId.delete(terminalId);
		if (this.lastFocusedTerminalId === terminalId) {
			this.lastFocusedTerminalId = undefined;
		}
		this.onDidChangeOpenSessionsEmitter.fire();

		const exitReason = terminal.exitStatus?.reason;
		if (exitReason === vscode.TerminalExitReason.Shutdown || exitReason === undefined || exitReason === vscode.TerminalExitReason.Unknown) {
			return;
		}
		void this.removeSession(context, terminalId);
	}

	private static async removeSession(context: vscode.ExtensionContext, terminalId: string): Promise<void> {
		const sessions = context.workspaceState.get<TerminalSessionMap>(terminalSessionsKey, {});
		if (!(terminalId in sessions)) {
			return;
		}
		const { [terminalId]: _removed, ...remainingSessions } = sessions;
		await context.workspaceState.update(terminalSessionsKey, remainingSessions);
	}

	private static async restore(context: vscode.ExtensionContext): Promise<void> {
		if (vscode.window.terminals.some((terminal) => terminal.name === 'Crust')) {
			return;
		}
		await this.ensureBridge(context);
		const sessions = context.workspaceState.get<TerminalSessionMap>(terminalSessionsKey, {});
		const validSessions: TerminalSessionMap = {};
		for (const [terminalId, sessionFile] of Object.entries(sessions)) {
			if (sessionFile && !existsSync(sessionFile)) {
				continue;
			}
			validSessions[terminalId] = sessionFile;
			const terminal = this.createTerminal(context, terminalId, this.buildPiArgs(context, sessionFile || undefined));
			this.terminalIds.set(terminal, terminalId);
			this.terminalsById.set(terminalId, terminal);
			this.sessionFilesByTerminalId.set(terminalId, sessionFile);
			terminal.show();
			await this.lockEditorGroupIfEnabled();
		}
		await context.workspaceState.update(terminalSessionsKey, validSessions);
	}

	private static async lockEditorGroupIfEnabled(): Promise<void> {
		if (getLockEditorGroupOnOpenSetting()) {
			await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
		}
	}

	private static isIdeContextEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
		return editor?.document.uri.scheme === 'file' || editor?.document.uri.scheme === 'untitled';
	}

	private static getCurrentTextEditor(): vscode.TextEditor | undefined {
		if (this.isIdeContextEditor(vscode.window.activeTextEditor)) {
			return vscode.window.activeTextEditor;
		}
		if (this.isIdeContextEditor(this.lastActiveTextEditor)) {
			return this.lastActiveTextEditor;
		}
		return vscode.window.visibleTextEditors.find((editor) => this.isIdeContextEditor(editor));
	}

	private static async writeIdeContext(): Promise<void> {
		if (!this.contextFile) {
			return;
		}
		this.lastActiveTextEditor = this.getCurrentTextEditor();
		const ideContext = getIdeContext(this.lastActiveTextEditor);
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const payload = ideContext ? { ...ideContext, workspaceRoot } : { workspaceRoot };
		try {
			await mkdir(dirname(this.contextFile), { recursive: true });
			await writeFile(this.contextFile, JSON.stringify(payload), 'utf8');
		} catch {
			// Best-effort IDE context; Pi can still run without it.
		}
	}
}
