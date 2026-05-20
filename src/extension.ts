import * as vscode from 'vscode';
import { CrustChatPanel } from './ui/chatPanel';
import { CrustTerminalView, getUseTerminalViewByDefaultSetting } from './ui/terminalView';
import { CrustSessionExplorer } from './ui/sessionExplorer';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		CrustTerminalView.register(context),
		CrustSessionExplorer.register(context),
		vscode.commands.registerCommand('crust.openChat', () => CrustChatPanel.show(context)),
		vscode.commands.registerCommand('crust.openChatTerminal', () => CrustTerminalView.show(context)),
		vscode.commands.registerCommand('crust.openChatDefault', () => getUseTerminalViewByDefaultSetting() ? CrustTerminalView.show(context) : CrustChatPanel.show(context)),
		CrustChatPanel.registerSerializer(context),
	);
}

export function deactivate(): void {}
