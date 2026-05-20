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
			new vscode.Disposable(() => this.bridgeServer?.close()),
		];
		this.listenersRegistered = true;
		return vscode.Disposable.from(...disposables);
	}

	static async show(context: vscode.ExtensionContext): Promise<void> {
		if (!this.listenersRegistered) {
			context.subscriptions.push(this.register(context));
		}
		await this.writeIdeContext();

		await this.ensureBridge(context);
		const terminalId = randomUUID();
		const args = this.buildPiArgs(context);
		const terminal = this.createTerminal(context, terminalId, args);
		this.terminalIds.set(terminal, terminalId);
		await this.updateSession(context, terminalId, '');
		terminal.show();
		await this.lockEditorGroupIfEnabled();
	}

	private static createTerminal(context: vscode.ExtensionContext, terminalId: string, args: string[]): vscode.Terminal {
		return vscode.window.createTerminal({
			name: 'Crust',
			shellPath: getPiCommandPathSetting(),
			shellArgs: args,
			location: { viewColumn: vscode.ViewColumn.Beside },
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

	private static async updateSession(context: vscode.ExtensionContext, terminalId: string, sessionFile: string): Promise<void> {
		const sessions = context.workspaceState.get<TerminalSessionMap>(terminalSessionsKey, {});
		await context.workspaceState.update(terminalSessionsKey, { ...sessions, [terminalId]: sessionFile });
	}

	private static onDidCloseTerminal(context: vscode.ExtensionContext, terminal: vscode.Terminal): void {
		const terminalId = this.terminalIds.get(terminal);
		const exitReason = terminal.exitStatus?.reason;
		if (!terminalId || exitReason === vscode.TerminalExitReason.Shutdown || exitReason === undefined || exitReason === vscode.TerminalExitReason.Unknown) {
			return;
		}
		const sessions = context.workspaceState.get<TerminalSessionMap>(terminalSessionsKey, {});
		if (!(terminalId in sessions)) {
			return;
		}
		const { [terminalId]: _removed, ...remainingSessions } = sessions;
		void context.workspaceState.update(terminalSessionsKey, remainingSessions);
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
