import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { IdeContext } from './chatTypes';

export function getIdeContext(editor: vscode.TextEditor | undefined): IdeContext | undefined {
	if (!editor) {
		return undefined;
	}

	const uri = editor.document.uri;
	if (uri.scheme !== 'file' && uri.scheme !== 'untitled') {
		return undefined;
	}

	const filePath = uri.scheme === 'file'
		? vscode.workspace.asRelativePath(uri, false)
		: editor.document.fileName;
	const fileName = basename(filePath) || filePath;
	const selection = editor.selection;
	if (selection && !selection.isEmpty) {
		const selectionRange = formatSelectionRange(selection);
		return {
			label: `${fileName}:${selectionRange}`,
			filePath,
			languageId: editor.document.languageId,
			selectionRange,
			selectedText: editor.document.getText(selection),
		};
	}

	return { label: fileName, filePath, languageId: editor.document.languageId };
}

export function formatSelectionRange(selection: vscode.Selection): string {
	const startLine = selection.start.line + 1;
	const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
		? selection.end.line
		: selection.end.line + 1;
	return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
}

export function buildPromptWithIdeContext(prompt: string, ideContext: IdeContext): string {
	const lines = [
		'<ide_context>',
		`Current file: ${ideContext.filePath}`,
	];
	if (ideContext.selectionRange && ideContext.selectedText !== undefined) {
		lines.push(
			`Selected lines: ${ideContext.selectionRange}`,
			'Selected text:',
			`\`\`\`${ideContext.languageId}`,
			ideContext.selectedText,
			'```',
		);
	}
	lines.push('</ide_context>', '', prompt);
	return lines.join('\n');
}

export function extractRestoredPrompt(text: string): { text: string; ideContextLabel?: string } {
	const match = text.match(/^<ide_context>\n([\s\S]*?)\n<\/ide_context>\n*/);
	if (!match) {
		return { text };
	}

	const contextText = match[1];
	const filePath = contextText.match(/^Current file: (.+)$/m)?.[1]?.trim();
	const selectedLines = contextText.match(/^Selected lines: (.+)$/m)?.[1]?.trim();
	const fileName = filePath ? basename(filePath) : undefined;
	return {
		text: text.slice(match[0].length).trimStart(),
		ideContextLabel: fileName ? `${fileName}${selectedLines ? `:${selectedLines}` : ''}` : undefined,
	};
}
