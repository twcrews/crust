import type { Dirent } from 'node:fs';

export type WebviewMessage = {
	type?: string;
	text?: string;
	modelKey?: string;
	commandName?: string;
	commandText?: string;
	requestId?: number;
	query?: string;
	message?: string;
	details?: unknown;
	includeIdeContext?: boolean;
};

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
