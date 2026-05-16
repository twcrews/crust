import * as vscode from 'vscode';
import { CrustChatPanel } from './ui/chatPanel';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('crust.openChat', () => CrustChatPanel.show(context)),
		CrustChatPanel.registerSerializer(context),
	);
}

export function deactivate(): void {}
