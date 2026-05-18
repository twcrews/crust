import { isToolResult } from '../pi/rpcTypes';
import { createId, getAbortMessage, isAbortedAssistantMessage, truncate } from './chatPanelUtils';
import { extractRestoredPrompt } from './ideContext';
import { getBlockText, getBlockType, getMessageContent, getMessageRole, getMessageText } from './messageUtils';
import { getToolBody, getToolHeaderDetail, getToolResultText, isRenderableTool } from './toolUtils';

type PostFn = (message: unknown) => void;

type RestoredToolCall = { elementId: string; name?: string; args?: unknown };

export function restoreSessionMessages(
	messages: unknown[],
	sessionName: string | undefined,
	post: PostFn,
	getSlashCommandLabel: (text: string) => string | undefined,
): { title: string; hasSessionTitle: boolean } {
	const restoredToolCalls = new Map<string, RestoredToolCall>();
	let firstUserMessage: string | undefined;
	for (const message of messages) {
		const restoredFirstUserMessage = restoreMessage(message, restoredToolCalls, post, getSlashCommandLabel);
		firstUserMessage ??= restoredFirstUserMessage;
	}

	const title = sessionName ? extractRestoredPrompt(sessionName).text : firstUserMessage || 'New Chat';
	return { title: truncate(title, 50), hasSessionTitle: Boolean(firstUserMessage || sessionName) };
}

function restoreMessage(
	message: unknown,
	toolCalls: Map<string, RestoredToolCall>,
	post: PostFn,
	getSlashCommandLabel: (text: string) => string | undefined,
): string | undefined {
	const role = getMessageRole(message);
	if (role === 'user') {
		const restoredPrompt = extractRestoredPrompt(getMessageText(message).trim());
		const slashCommandLabel = restoredPrompt.skillLabel ?? getSlashCommandLabel(restoredPrompt.text);
		if (restoredPrompt.text || slashCommandLabel) {
			post({
				type: 'addMessage',
				id: createId('user'),
				role: 'user',
				text: slashCommandLabel && !restoredPrompt.skillLabel ? '' : restoredPrompt.text,
				ideContextLabel: restoredPrompt.ideContextLabel,
				slashCommandLabel,
			});
			return slashCommandLabel ?? restoredPrompt.text;
		}
		return undefined;
	}

	if (role === 'assistant') {
		restoreAssistantMessage(message, toolCalls, post);
		return undefined;
	}

	if (role === 'toolResult') {
		restoreToolResult(message, toolCalls, post);
		return undefined;
	}

	if (role === 'compactionSummary') {
		restoreCompactionSummary(message, post);
		return undefined;
	}

	const text = getMessageText(message).trim();
	if (text) {
		post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text });
	}
	return undefined;
}

function restoreCompactionSummary(message: unknown, post: PostFn): void {
	const record = typeof message === 'object' && message !== null ? message as { summary?: unknown; tokensBefore?: unknown } : undefined;
	const summary = typeof record?.summary === 'string' ? record.summary.trim() : '';
	if (!summary) {
		return;
	}
	const tokensBefore = typeof record?.tokensBefore === 'number' && Number.isFinite(record.tokensBefore)
		? ` (${Math.round(record.tokensBefore / 1000)}k tokens summarized)`
		: '';
	post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: `Context compacted${tokensBefore}.\n\n${summary}`, secondary: true, compaction: true });
}

function restoreAssistantMessage(message: unknown, toolCalls: Map<string, RestoredToolCall>, post: PostFn): void {
	const content = getMessageContent(message);
	if (typeof content === 'string') {
		post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: content });
		restoreAbortIndicator(message, post);
		return;
	}

	if (!Array.isArray(content)) {
		restoreAbortIndicator(message, post);
		return;
	}

	for (const block of content) {
		const type = getBlockType(block);
		if (type === 'text') {
			const text = getBlockText(block, 'text').trim();
			if (text) {
				post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text });
			}
		}
		if (type === 'thinking') {
			const thinking = getBlockText(block, 'thinking');
			if (thinking.trim()) {
				const id = createId('thinking');
				post({ type: 'addThinking', id });
				post({ type: 'appendThinking', id, text: thinking });
			}
		}
		if (type === 'toolCall') {
			restoreToolCall(block, toolCalls, post);
		}
	}
	restoreAbortIndicator(message, post);
}

function restoreAbortIndicator(message: unknown, post: PostFn): void {
	if (!isAbortedAssistantMessage(message)) {
		return;
	}
	post({ type: 'addMessage', id: createId('assistant'), role: 'assistant', text: `_${getAbortMessage(message)}_`, secondary: true });
}

function restoreToolCall(block: unknown, toolCalls: Map<string, RestoredToolCall>, post: PostFn): void {
	const record = block as { id?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown; args?: unknown };
	const toolCallId = typeof record.id === 'string' ? record.id : createId('restored-toolcall-id');
	const name = typeof record.name === 'string' ? record.name : typeof record.toolName === 'string' ? record.toolName : undefined;
	const args = record.arguments ?? record.args;
	if (!isRenderableTool(name)) {
		return;
	}

	const elementId = createId('restored-tool');
	toolCalls.set(toolCallId, { elementId, name, args });
	post({
		type: 'upsertTool',
		id: elementId,
		toolName: name,
		path: getToolHeaderDetail(name, args),
		status: 'pending',
		body: getToolBody(name, args),
		isDiff: name === 'edit',
	});
}

function restoreToolResult(message: unknown, toolCalls: Map<string, RestoredToolCall>, post: PostFn): void {
	const record = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
	const toolCall = typeof record.toolCallId === 'string' ? toolCalls.get(record.toolCallId) : undefined;
	const name = typeof record.toolName === 'string' ? record.toolName : toolCall?.name;
	if (!isRenderableTool(name)) {
		return;
	}

	const result = isToolResult(message) ? message : undefined;
	const diff = typeof result?.details?.diff === 'string' ? result.details.diff : undefined;
	const isError = record.isError === true;
	post({
		type: 'upsertTool',
		id: toolCall?.elementId ?? createId('restored-tool'),
		toolName: name,
		path: getToolHeaderDetail(name, toolCall?.args, isError ? undefined : result),
		status: isError ? 'error' : 'done',
		body: name === 'read' && !isError ? undefined : diff ?? getToolResultText(result) ?? getToolBody(name, toolCall?.args),
		isDiff: Boolean(diff),
	});
}
