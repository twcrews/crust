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
