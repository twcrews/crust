export type RpcResponse = {
	id?: string;
	type: 'response';
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

export type RpcEvent = ModelSelectEvent
	| AgentStartEvent
	| AgentEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| MessageUpdateEvent
	| MessageEndEvent;

export type ModelSelectEvent = {
	type: 'model_select';
	model: Model;
	previousModel?: Model;
};

export type AgentStartEvent = {
	type: 'agent_start';
};

export type AgentEndEvent = {
	type: 'agent_end';
	message?: RpcMessage;
	messages?: RpcMessage[];
};

export type ToolExecutionStartEvent = {
	type: 'tool_execution_start';
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
};

export type ToolExecutionUpdateEvent = {
	type: 'tool_execution_update';
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	partialResult?: ToolResult;
};

export type ToolExecutionEndEvent = {
	type: 'tool_execution_end';
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	result?: ToolResult;
	isError?: boolean;
};

export type MessageUpdateEvent = {
	type: 'message_update';
	message?: RpcMessage;
	toolCallId?: string;
	assistantMessageEvent?: AssistantMessageEvent;
};

export type MessageEndEvent = {
	type: 'message_end';
	message?: RpcMessage;
};

export type RpcMessage = Record<string, unknown> & {
	content?: unknown;
	error?: unknown;
	errorMessage?: unknown;
	message?: unknown;
	reason?: unknown;
	role?: unknown;
	stopReason?: unknown;
	usage?: unknown;
};

export type AssistantMessageEvent = {
	type: string;
	contentIndex?: number;
	delta?: string;
	reason?: string;
	partial?: unknown;
	toolCall?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

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
	return isRecord(value)
		&& typeof value.name === 'string'
		&& (value.description === undefined || typeof value.description === 'string')
		&& (value.source === undefined || typeof value.source === 'string')
		&& (value.location === undefined || typeof value.location === 'string')
		&& (value.path === undefined || typeof value.path === 'string')
		&& (value.sourceInfo === undefined || isSlashCommandSourceInfo(value.sourceInfo));
}

export function isSlashCommandSourceInfo(value: unknown): value is SlashCommandSourceInfo {
	return isRecord(value)
		&& typeof value.path === 'string'
		&& typeof value.source === 'string'
		&& typeof value.scope === 'string'
		&& typeof value.origin === 'string'
		&& (value.baseDir === undefined || typeof value.baseDir === 'string');
}

export function isRpcResponse(message: unknown): message is RpcResponse {
	return isRecord(message)
		&& message.type === 'response'
		&& typeof message.command === 'string'
		&& typeof message.success === 'boolean';
}

export function isRpcEvent(message: unknown): message is RpcEvent {
	if (!isRecord(message) || typeof message.type !== 'string') {
		return false;
	}

	const baseEventFieldsValid = hasOptionalString(message, 'toolCallId')
		&& hasOptionalString(message, 'toolName')
		&& hasOptionalBoolean(message, 'isError');
	if (!baseEventFieldsValid) {
		return false;
	}

	switch (message.type) {
		case 'model_select':
			return isModel(message.model)
				&& (message.previousModel === undefined || isModel(message.previousModel));
		case 'agent_start':
			return true;
		case 'agent_end':
			return (message.message === undefined || isRecord(message.message))
				&& (message.messages === undefined || (Array.isArray(message.messages) && message.messages.every(isRecord)));
		case 'tool_execution_start':
			return true;
		case 'tool_execution_update':
			return message.partialResult === undefined || isToolResult(message.partialResult);
		case 'tool_execution_end':
			return message.result === undefined || isToolResult(message.result);
		case 'message_update':
			return (message.message === undefined || isRecord(message.message))
				&& (message.assistantMessageEvent === undefined || isAssistantMessageEvent(message.assistantMessageEvent));
		case 'message_end':
			return message.message === undefined || isRecord(message.message);
		default:
			return false;
	}
}

function isModel(value: unknown): value is Model {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.provider === 'string'
		&& (value.name === undefined || typeof value.name === 'string');
}

export function isToolResult(value: unknown): value is ToolResult {
	if (!isRecord(value)) {
		return false;
	}
	if (value.content !== undefined && !isToolContent(value.content)) {
		return false;
	}
	return value.details === undefined || isRecord(value.details);
}

function isToolContent(value: unknown): value is ToolResult['content'] {
	return Array.isArray(value) && value.every((item) => isRecord(item)
		&& (item.type === undefined || typeof item.type === 'string')
		&& (item.text === undefined || typeof item.text === 'string'));
}

function isAssistantMessageEvent(value: unknown): value is AssistantMessageEvent {
	return isRecord(value)
		&& typeof value.type === 'string'
		&& (value.contentIndex === undefined || (typeof value.contentIndex === 'number' && Number.isInteger(value.contentIndex)))
		&& (value.delta === undefined || typeof value.delta === 'string')
		&& (value.reason === undefined || typeof value.reason === 'string');
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === 'string';
}

function hasOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === 'boolean';
}
