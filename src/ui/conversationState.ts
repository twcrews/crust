export type ConversationState = {
	isProcessing: boolean;
	isStreaming: boolean;
	activeThinkingMessageId: string | undefined;
	activeLoadingMessageId: string | undefined;
	hasSessionTitle: boolean;
	activeToolCallIds: Map<string, string>;
	activeToolCallArgs: Map<string, unknown>;
	activeTextMessageIds: Map<number, string>;
	activeAbortIndicatorShown: boolean;
	activeErrorMessageShown: boolean;
	usageMessages: unknown[];
	activeUsageMessage: unknown;
};

export function createConversationState(): ConversationState {
	return {
		isProcessing: false,
		isStreaming: false,
		activeThinkingMessageId: undefined,
		activeLoadingMessageId: undefined,
		hasSessionTitle: false,
		activeToolCallIds: new Map<string, string>(),
		activeToolCallArgs: new Map<string, unknown>(),
		activeTextMessageIds: new Map<number, string>(),
		activeAbortIndicatorShown: false,
		activeErrorMessageShown: false,
		usageMessages: [],
		activeUsageMessage: undefined,
	};
}

export function resetStreamingState(state: ConversationState): void {
	state.isStreaming = false;
	state.activeThinkingMessageId = undefined;
	state.activeToolCallIds.clear();
	state.activeToolCallArgs.clear();
	state.activeTextMessageIds.clear();
}

export function prepareStreamingState(state: ConversationState): void {
	state.activeThinkingMessageId = undefined;
	state.activeToolCallIds.clear();
	state.activeToolCallArgs.clear();
	state.activeTextMessageIds.clear();
	state.activeAbortIndicatorShown = false;
	state.activeErrorMessageShown = false;
}
