import type { MessageUpdateEvent, Model, RpcEvent, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent } from '../pi/rpcTypes';
import { createId, formatErrorForChat, getAbortMessage, getAssistantErrorMessage, getLastAssistantMessage, getMessageContentAt, hasMessageUsage, isAbortedAssistantMessage, toolElementId } from './chatPanelUtils';
import { prepareStreamingState, resetStreamingState, type ConversationState } from './conversationState';
import { getToolBody, getToolHeaderDetail, getToolResultText, isRenderableTool } from './toolUtils';

export type StreamingEventRendererCallbacks = {
	post: (message: unknown) => void;
	setProcessing: (isProcessing: boolean) => void;
	setCurrentModel: (model: Model) => void;
	finalizeUsageStatus: (message: unknown) => void;
	postCurrentUsageStatus: () => void;
	postCurrentSessionPath: () => void;
	refreshCurrentModel: () => void;
};

export class StreamingEventRenderer {
	constructor(
		private readonly state: ConversationState,
		private readonly callbacks: StreamingEventRendererCallbacks,
	) {}

	handlePiEvent(event: RpcEvent): void {
		if (event.type === 'model_select' && event.model) {
			this.callbacks.setCurrentModel(event.model);
			return;
		}
		if (event.type === 'agent_start') {
			this.callbacks.setProcessing(true);
			this.state.isStreaming = true;
			prepareStreamingState(this.state);
			return;
		}

		if (event.type === 'agent_end') {
			const assistantMessage = event.message ?? getLastAssistantMessage(event.messages);
			this.handleTerminalAssistantMessage(assistantMessage);
			this.callbacks.setProcessing(false);
			resetStreamingState(this.state);
			this.removeActiveLoadingMessage();
			this.callbacks.finalizeUsageStatus(assistantMessage);
			this.callbacks.postCurrentSessionPath();
			this.callbacks.refreshCurrentModel();
			return;
		}

		if (event.type === 'tool_execution_start') {
			this.showToolExecutionStart(event);
			return;
		}
		if (event.type === 'tool_execution_update') {
			this.showToolExecutionUpdate(event);
			return;
		}
		if (event.type === 'tool_execution_end') {
			this.showToolExecutionEnd(event);
			return;
		}
		if (event.type === 'message_end') {
			this.handleTerminalAssistantMessage(event.message);
			this.callbacks.finalizeUsageStatus(event.message);
			return;
		}
		if (event.type !== 'message_update') {
			return;
		}

		this.showStreamingUsage(event);
		this.showStreamingThinking(event);
		this.showStreamingToolCall(event);
		this.showAbortIndicator(event.message);

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
			this.callbacks.post({ type: 'appendMessage', id: this.getStreamingTextMessageId(assistantEvent.contentIndex ?? 0), text: assistantEvent.delta });
		}
		if (assistantEvent?.type === 'error') {
			const assistantErrorMessage = getAssistantErrorMessage(event.message);
			const message = assistantErrorMessage ?? assistantEvent.reason ?? 'unknown error';
			this.showAssistantErrorInChat(message, assistantEvent.contentIndex ?? 0);
		}
	}

	private handleTerminalAssistantMessage(message: unknown): void {
		this.showAbortIndicator(message);
		const errorMessage = getAssistantErrorMessage(message);
		if (errorMessage) {
			this.showAssistantErrorInChat(errorMessage);
		}
	}

	private showAssistantErrorInChat(message: string, contentIndex = 0): void {
		if (this.state.activeErrorMessageShown) {
			return;
		}
		this.state.activeErrorMessageShown = true;
		this.callbacks.post({ type: 'appendMessage', id: this.getStreamingTextMessageId(contentIndex), text: `\n${formatErrorForChat(message)}`, error: true });
	}

	private showAbortIndicator(message: unknown): void {
		if (this.state.activeAbortIndicatorShown || !isAbortedAssistantMessage(message)) {
			return;
		}
		this.state.activeAbortIndicatorShown = true;
		this.callbacks.post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: `_${getAbortMessage(message)}_`, secondary: true });
	}

	private getStreamingTextMessageId(contentIndex: number): string {
		const existing = this.state.activeTextMessageIds.get(contentIndex);
		if (existing) {
			return existing;
		}
		const id = createId('assistant');
		this.state.activeTextMessageIds.set(contentIndex, id);
		this.callbacks.post({ type: 'addMessage', id, role: 'assistant', text: '' });
		return id;
	}

	private removeActiveLoadingMessage(): void {
		if (!this.state.activeLoadingMessageId) {
			return;
		}
		this.callbacks.post({ type: 'removeMessage', id: this.state.activeLoadingMessageId });
		this.state.activeLoadingMessageId = undefined;
	}

	private showToolExecutionStart(event: ToolExecutionStartEvent): void {
		if (!isRenderableTool(event.toolName)) {
			return;
		}
		const args = event.args ?? (event.toolCallId ? this.state.activeToolCallArgs.get(event.toolCallId) : undefined);
		this.callbacks.post({ type: 'upsertTool', id: toolElementId(event.toolCallId), toolName: event.toolName, path: getToolHeaderDetail(event.toolName, args), status: 'running', body: getToolBody(event.toolName, args) });
	}

	private showToolExecutionUpdate(event: ToolExecutionUpdateEvent): void {
		if (!isRenderableTool(event.toolName) || event.toolName === 'read') {
			return;
		}
		const args = event.args ?? (event.toolCallId ? this.state.activeToolCallArgs.get(event.toolCallId) : undefined);
		this.callbacks.post({ type: 'upsertTool', id: toolElementId(event.toolCallId), toolName: event.toolName, path: getToolHeaderDetail(event.toolName, args), status: 'running', body: getToolResultText(event.partialResult) });
	}

	private showToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (!isRenderableTool(event.toolName)) {
			return;
		}
		const args = event.args ?? (event.toolCallId ? this.state.activeToolCallArgs.get(event.toolCallId) : undefined);
		const diff = typeof event.result?.details?.diff === 'string' ? event.result.details.diff : undefined;
		this.callbacks.post({ type: 'upsertTool', id: toolElementId(event.toolCallId), toolName: event.toolName, path: getToolHeaderDetail(event.toolName, args, event.isError ? undefined : event.result), status: event.isError ? 'error' : 'done', body: event.toolName === 'read' ? undefined : diff ?? getToolResultText(event.result) ?? getToolBody(event.toolName, args), isDiff: Boolean(diff) });
	}

	private showStreamingUsage(event: MessageUpdateEvent): void {
		if (event.message === undefined || !hasMessageUsage(event.message)) {
			return;
		}
		this.state.activeUsageMessage = event.message;
		this.callbacks.postCurrentUsageStatus();
	}

	private showStreamingThinking(event: MessageUpdateEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === 'thinking_start') {
			this.state.activeThinkingMessageId = undefined;
			return;
		}
		if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
			if (!this.state.activeThinkingMessageId) {
				this.state.activeThinkingMessageId = createId('thinking');
				this.callbacks.post({ type: 'addThinking', id: this.state.activeThinkingMessageId });
			}
			this.callbacks.post({ type: 'appendThinking', id: this.state.activeThinkingMessageId, text: assistantEvent.delta });
		}
	}

	private showStreamingToolCall(event: MessageUpdateEvent): void {
		const assistantEvent = event.assistantMessageEvent;
		if (!assistantEvent?.type.startsWith('toolcall_')) {
			return;
		}
		const toolCall = this.extractToolCall(event);
		if (!isRenderableTool(toolCall.name)) {
			return;
		}
		if (toolCall.id && toolCall.args !== undefined) {
			this.state.activeToolCallArgs.set(toolCall.id, toolCall.args);
		}
		const contentIndex = assistantEvent.contentIndex ?? 0;
		const indexKey = `index:${contentIndex}`;
		const toolKey = toolCall.id ? `id:${toolCall.id}` : indexKey;
		const existingId = this.state.activeToolCallIds.get(toolKey) ?? this.state.activeToolCallIds.get(indexKey);
		const id = toolCall.id ? toolElementId(toolCall.id) : existingId ?? createId('toolcall');
		if (toolCall.id) {
			const temporaryId = this.state.activeToolCallIds.get(indexKey);
			if (temporaryId && temporaryId !== id) {
				this.callbacks.post({ type: 'removeMessage', id: temporaryId });
			}
			this.state.activeToolCallIds.delete(indexKey);
		}
		this.state.activeToolCallIds.set(toolKey, id);
		this.callbacks.post({ type: 'upsertTool', id, toolName: toolCall.name, path: getToolHeaderDetail(toolCall.name, toolCall.args), status: assistantEvent.type === 'toolcall_end' ? 'pending' : 'drafting', body: getToolBody(toolCall.name, toolCall.args), isDiff: toolCall.name === 'edit' });
	}

	private extractToolCall(event: MessageUpdateEvent): { id?: string; name?: string; args?: unknown } {
		const assistantEvent = event.assistantMessageEvent;
		const candidates = [assistantEvent?.toolCall, assistantEvent?.partial, getMessageContentAt(event.message, assistantEvent?.contentIndex)];
		const candidate = candidates.find((value) => typeof value === 'object' && value !== null);
		const record = candidate as { id?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown; args?: unknown } | undefined;
		return {
			id: typeof record?.id === 'string' ? record.id : event.toolCallId,
			name: typeof record?.name === 'string' ? record.name : typeof record?.toolName === 'string' ? record.toolName : undefined,
			args: record?.arguments ?? record?.args,
		};
	}
}
