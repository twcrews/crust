import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { getNonce } from '../utils/nonce';

export function getChatWebviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
	const nonce = getNonce();
	const htmlPath = join(extensionUri.fsPath, 'media', 'chatWebview.html');
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chatWebview.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chatWebview.js'));
	const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'branding', 'icon.svg'));

	return readFileSync(htmlPath, 'utf8')
		.replace(/{{nonce}}/g, nonce)
		.replace(/{{styleUri}}/g, String(styleUri))
		.replace(/{{scriptUri}}/g, String(scriptUri))
		.replace(/{{iconUri}}/g, String(iconUri))
		.replace(/{{cspSource}}/g, webview.cspSource);
}
