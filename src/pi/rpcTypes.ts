export type RpcResponse = {
	id?: string;
	type: 'response';
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

export type RpcEvent = {
	type: string;
	message?: unknown;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	partialResult?: ToolResult;
	result?: ToolResult;
	isError?: boolean;
	assistantMessageEvent?: {
		type: string;
		contentIndex?: number;
		delta?: string;
		reason?: string;
		partial?: unknown;
		toolCall?: unknown;
	};
};

export type ToolResult = {
	content?: Array<{ type?: string; text?: string }>;
	details?: { diff?: string; [key: string]: unknown };
};

export type Model = {
	id: string;
	name?: string;
	provider: string;
};

export type SlashCommandSourceInfo = {
	path: string;
	source: string;
	scope: 'user' | 'project' | 'temporary' | string;
	origin: 'package' | 'top-level' | string;
	baseDir?: string;
};

export type SlashCommand = {
	name: string;
	description?: string;
	source?: string;
	location?: string;
	path?: string;
	sourceInfo?: SlashCommandSourceInfo;
};

export function normalizeSlashCommand(value: unknown): SlashCommand | undefined {
	if (!isSlashCommand(value)) {
		return undefined;
	}

	return {
		...value,
		location: value.location ?? value.sourceInfo?.scope,
		path: value.path ?? value.sourceInfo?.path,
	};
}

export function isSlashCommand(value: unknown): value is SlashCommand {
	return typeof value === 'object'
		&& value !== null
		&& typeof (value as { name?: unknown }).name === 'string'
		&& ((value as { description?: unknown }).description === undefined || typeof (value as { description?: unknown }).description === 'string')
		&& ((value as { source?: unknown }).source === undefined || typeof (value as { source?: unknown }).source === 'string')
		&& ((value as { location?: unknown }).location === undefined || typeof (value as { location?: unknown }).location === 'string')
		&& ((value as { path?: unknown }).path === undefined || typeof (value as { path?: unknown }).path === 'string')
		&& ((value as { sourceInfo?: unknown }).sourceInfo === undefined || isSlashCommandSourceInfo((value as { sourceInfo?: unknown }).sourceInfo));
}

export function isSlashCommandSourceInfo(value: unknown): value is SlashCommandSourceInfo {
	return typeof value === 'object'
		&& value !== null
		&& typeof (value as { path?: unknown }).path === 'string'
		&& typeof (value as { source?: unknown }).source === 'string'
		&& typeof (value as { scope?: unknown }).scope === 'string'
		&& typeof (value as { origin?: unknown }).origin === 'string'
		&& ((value as { baseDir?: unknown }).baseDir === undefined || typeof (value as { baseDir?: unknown }).baseDir === 'string');
}

export function isRpcResponse(message: unknown): message is RpcResponse {
	return typeof message === 'object'
		&& message !== null
		&& (message as { type?: unknown }).type === 'response'
		&& typeof (message as { command?: unknown }).command === 'string'
		&& typeof (message as { success?: unknown }).success === 'boolean';
}

export function isRpcEvent(message: unknown): message is RpcEvent {
	return typeof message === 'object'
		&& message !== null
		&& typeof (message as { type?: unknown }).type === 'string';
}
