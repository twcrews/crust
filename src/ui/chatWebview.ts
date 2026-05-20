import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { getNonce } from '../utils/nonce';

export function getChatWebviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview, options: { allowRawHtml: boolean; includeIdeContextByDefault: boolean } = { allowRawHtml: false, includeIdeContextByDefault: false }): string {
	const nonce = getNonce();
	const htmlPath = join(extensionUri.fsPath, 'media', 'chatWebview.html');
	const styleFiles = [
		'chatWebview.base.css',
		'chatWebview.header.css',
		'chatWebview.messages.css',
		'chatWebview.markdown.css',
		'chatWebview.tools.css',
		'chatWebview.controls.css',
		'chatWebview.navigation.css',
		'chatWebview.responsive.css',
	];
	const styleTags = styleFiles
		.map((file) => {
			const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chatWebview', file));
			return `<link rel="stylesheet" href="${styleUri}">`;
		})
		.join('\n\t');
	const scriptFiles = [
		'generated/markdown-it.bundle.js',
		'chatWebview.state.js',
		'chatWebview.logging.js',
		'chatWebview.rendering.js',
		'chatWebview.autocomplete.js',
		'chatWebview.navigation.js',
		'chatWebview.main.js',
	];
	const initialSettingsScript = `<script nonce="${nonce}">window.crustInitialSettings = ${JSON.stringify({ allowRawHtml: options.allowRawHtml, includeIdeContextByDefault: options.includeIdeContextByDefault })};</script>`;
	const scriptTags = initialSettingsScript + '\n\t' + scriptFiles
		.map((file) => {
			const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chatWebview', file));
			return `<script nonce="${nonce}" src="${scriptUri}"></script>`;
		})
		.join('\n\t');
	const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'branding', 'icon.svg'));

	return readFileSync(htmlPath, 'utf8')
		.replace(/{{nonce}}/g, nonce)
		.replace(/{{styleTags}}/g, styleTags)
		.replace(/{{scriptTags}}/g, scriptTags)
		.replace(/{{iconUri}}/g, String(iconUri))
		.replace(/{{cspSource}}/g, webview.cspSource);
}
