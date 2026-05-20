import * as vscode from 'vscode';
import { getCrustOutputChannel } from '../utils/crustLogger';
import { errorMessage } from '../utils/errorMessage';
import { getNonce } from '../utils/nonce';
import type { SessionInfo } from './chatTypes';
import { formatSessionDate, getInitialCwd, truncate } from './chatPanelUtils';
import { listSessionsForCwd } from './sessionHistory';
import { CrustChatPanel } from './chatPanel';
import { CrustTerminalView, getUseTerminalViewByDefaultSetting } from './terminalView';

type SessionWebviewMessage = { type: 'openSession'; path: string } | { type: 'refresh' };

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[character] ?? character));
}

export class CrustSessionExplorer implements vscode.WebviewViewProvider, vscode.Disposable {
	private readonly output = getCrustOutputChannel();
	private readonly disposables: vscode.Disposable[] = [];
	private sessions: SessionInfo[] = [];
	private loading = false;
	private view: vscode.WebviewView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new CrustSessionExplorer(context);
		return vscode.Disposable.from(
			provider,
			vscode.window.registerWebviewViewProvider('crust.sessions', provider, { webviewOptions: { retainContextWhenHidden: true } }),
			vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
			CrustChatPanel.onDidChangeOpenSessions(() => provider.render()),
			CrustTerminalView.onDidChangeOpenSessions(() => provider.render()),
			vscode.commands.registerCommand('crust.sessions.refresh', () => provider.refresh()),
			vscode.commands.registerCommand('crust.sessions.open', (session?: SessionInfo) => provider.openSession(session)),
			vscode.commands.registerCommand('crust.restoreSession', () => provider.showSessionQuickPick()),
		);
	}

	dispose(): void {
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		this.disposables.push(
			webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					void this.refresh();
				}
			}),
		);
		void this.refresh();
	}

	async showSessionQuickPick(): Promise<void> {
		try {
			const sessions = await listSessionsForCwd(getInitialCwd());
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

			await this.openSession(selected.session);
		} catch (error) {
			this.output.appendLine(`[sessionExplorer] Failed to show session selector: ${errorMessage(error)}`);
			void vscode.window.showErrorMessage(`Unable to load Pi sessions: ${errorMessage(error)}`);
		}
	}

	async refresh(): Promise<void> {
		this.loading = true;
		this.render();
		try {
			this.sessions = await listSessionsForCwd(getInitialCwd());
		} catch (error) {
			this.output.appendLine(`[sessionExplorer] Failed to list sessions: ${errorMessage(error)}`);
			this.sessions = [];
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private handleMessage(message: unknown): void {
		const parsed = this.parseMessage(message);
		if (!parsed) {
			return;
		}
		if (parsed.type === 'refresh') {
			void this.refresh();
			return;
		}
		const session = this.sessions.find((candidate) => candidate.path === parsed.path);
		void this.openSession(session);
	}

	private parseMessage(message: unknown): SessionWebviewMessage | undefined {
		if (typeof message !== 'object' || message === null) {
			return undefined;
		}
		const record = message as Record<string, unknown>;
		if (record.type === 'refresh') {
			return { type: 'refresh' };
		}
		return record.type === 'openSession' && typeof record.path === 'string'
			? { type: 'openSession', path: record.path }
			: undefined;
	}

	private render(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.html = this.getHtml(this.view.webview);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const content = this.getContentHtml();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { margin: 0; padding: 4px 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
		.message { padding: 8px 12px; color: var(--vscode-descriptionForeground); }
		.session { display: block; width: 100%; box-sizing: border-box; padding: 7px 12px 8px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; }
		.session:hover { background: var(--vscode-list-hoverBackground); }
		.session.open { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground); }
		.session.open .date { color: var(--vscode-list-inactiveSelectionForeground); opacity: 0.85; }
		.session:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.date { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	</style>
</head>
<body>
	<div id="sessions">${content}</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('.session[data-path]').forEach((button) => {
			button.addEventListener('click', () => vscode.postMessage({ type: 'openSession', path: button.dataset.path }));
		});
	</script>
</body>
</html>`;
	}

	private getContentHtml(): string {
		if (this.loading) {
			return '<div class="message">Loading Pi sessions...</div>';
		}
		if (!this.sessions.length) {
			return '<div class="message">No Pi sessions found</div>';
		}
		const openSessionPaths = new Set([...CrustChatPanel.getOpenSessionPaths(), ...CrustTerminalView.getOpenSessionPaths()]);
		return this.sessions.map((session) => {
			const title = session.name || truncate(session.firstMessage, 80);
			const tooltip = [title, session.firstMessage, `${session.messageCount} messages`, session.path].filter(Boolean).join('\n');
			const className = openSessionPaths.has(session.path) ? 'session open' : 'session';
			return `<button type="button" class="${className}" data-path="${escapeHtml(session.path)}" title="${escapeHtml(tooltip)}"><div class="title">${escapeHtml(title)}</div><div class="date">${escapeHtml(formatSessionDate(session.modified))}</div></button>`;
		}).join('');
	}

	private async openSession(session?: SessionInfo): Promise<void> {
		if (!session) {
			return;
		}
		if (CrustTerminalView.focusSession(session.path)) {
			return;
		}
		if (CrustChatPanel.hasOpenPanel()) {
			await CrustChatPanel.openSession(this.context, session.path);
			return;
		}
		if (getUseTerminalViewByDefaultSetting()) {
			if (CrustTerminalView.hasOpenTerminal()) {
				await CrustTerminalView.replaceSession(this.context, session.path);
				return;
			}
			await CrustTerminalView.show(this.context, session.path);
			return;
		}
		await CrustChatPanel.openSession(this.context, session.path);
	}
}
