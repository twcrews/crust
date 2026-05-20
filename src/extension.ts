import * as vscode from 'vscode';
import { CrustChatPanel } from './ui/chatPanel';
import { CrustTerminalView, getUseTerminalViewSetting } from './ui/terminalView';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		CrustTerminalView.register(context),
		vscode.commands.registerCommand('crust.openChat', () => getUseTerminalViewSetting() ? CrustTerminalView.show(context) : CrustChatPanel.show(context)),
		CrustChatPanel.registerSerializer(context),
	);
}

export function deactivate(): void {}
