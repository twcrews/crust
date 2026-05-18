import * as vscode from 'vscode';

export type CrustLogLevel = 'info' | 'warn' | 'error';

const output = vscode.window.createOutputChannel('Crust');

export function getCrustOutputChannel(): vscode.OutputChannel {
	return output;
}

export function logCrust(message: string, details?: unknown, level: CrustLogLevel = 'info'): void {
	const timestamp = new Date().toISOString();
	const suffix = details === undefined ? '' : ` ${stringifyLogDetails(details)}`;
	const prefix = level === 'info' ? '' : `${level.toUpperCase()} `;
	output.appendLine(`[${timestamp}] ${prefix}${message}${suffix}`);
}

function stringifyLogDetails(details: unknown): string {
	try {
		return JSON.stringify(details);
	} catch {
		return String(details);
	}
}
