import type { Dirent } from 'node:fs';

export type WebviewMessage =
	| { type: 'submit'; text: string; includeIdeContext: boolean }
	| { type: 'steer'; text: string }
	| { type: 'cancel' }
	| { type: 'selectModel'; modelKey: string | undefined }
	| { type: 'showHistory' }
	| { type: 'newChat' }
	| { type: 'slashCommand'; commandName: string; commandText: string }
	| { type: 'pathAutocomplete'; requestId: number; query: string }
	| { type: 'refreshSlashCommands' }
	| { type: 'webviewLog'; message: string; details: unknown; level: 'info' | 'warn' | 'error' };

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const message = value as Record<string, unknown>;
	if (typeof message.type !== 'string') {
		return undefined;
	}

	switch (message.type) {
		case 'submit':
			return typeof message.text === 'string'
				? { type: 'submit', text: message.text, includeIdeContext: message.includeIdeContext === true }
				: undefined;
		case 'steer':
			return typeof message.text === 'string' ? { type: 'steer', text: message.text } : undefined;
		case 'cancel':
		case 'showHistory':
		case 'newChat':
		case 'refreshSlashCommands':
			return { type: message.type };
		case 'selectModel':
			return message.modelKey === undefined || typeof message.modelKey === 'string'
				? { type: 'selectModel', modelKey: message.modelKey }
				: undefined;
		case 'slashCommand':
			return typeof message.commandName === 'string' && typeof message.commandText === 'string'
				? { type: 'slashCommand', commandName: message.commandName, commandText: message.commandText }
				: undefined;
		case 'pathAutocomplete':
			return typeof message.requestId === 'number' && typeof message.query === 'string'
				? { type: 'pathAutocomplete', requestId: message.requestId, query: message.query }
				: undefined;
		case 'webviewLog': {
			const level = message.level === 'warn' || message.level === 'error' ? message.level : 'info';
			return typeof message.message === 'string'
				? { type: 'webviewLog', message: message.message, details: message.details, level }
				: undefined;
		}
		default:
			return undefined;
	}
}

export type IdeContext = {
	label: string;
	filePath: string;
	languageId: string;
	selectionRange?: string;
	selectedText?: string;
};

export type SessionInfo = {
	path: string;
	name?: string;
	firstMessage: string;
	modified: Date;
	messageCount: number;
};

export type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	contextTokens: number;
	cost: number;
};

export type PathSuggestion = { path: string; name: string; isDirectory: boolean };
export type ScoredPathSuggestion = PathSuggestion & { score: number };
export type FsDirent = Dirent;
