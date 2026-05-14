export function getMessageContent(message: unknown): unknown {
	return typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined;
}

export function getBlockType(block: unknown): string | undefined {
	return typeof block === 'object' && block !== null && typeof (block as { type?: unknown }).type === 'string'
		? (block as { type: string }).type
		: undefined;
}

export function getBlockText(block: unknown, key: 'text' | 'thinking'): string {
	return typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>)[key] === 'string'
		? (block as Record<string, string>)[key]
		: '';
}

export function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export function getMessageRole(message: unknown): 'user' | 'assistant' | string | undefined {
	return typeof message === 'object' && message !== null && typeof (message as { role?: unknown }).role === 'string'
		? (message as { role: string }).role
		: undefined;
}

export function getMessageText(message: unknown): string {
	if (typeof message !== 'object' || message === null) {
		return '';
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.filter((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
		.map((block) => typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')
		.join('\n');
}

export function getMessageTimestamp(message: unknown): number | undefined {
	if (typeof message !== 'object' || message === null || typeof (message as { timestamp?: unknown }).timestamp !== 'number') {
		return undefined;
	}
	return (message as { timestamp: number }).timestamp;
}

export function getEntryTimestamp(entry: Record<string, unknown>): number | undefined {
	if (typeof entry.timestamp !== 'string') {
		return undefined;
	}
	const timestamp = new Date(entry.timestamp).getTime();
	return Number.isNaN(timestamp) ? undefined : timestamp;
}
