import type { RpcEvent } from '../pi/rpcTypes';

export function isFileTool(toolName: string | undefined): boolean {
	return toolName === 'read' || toolName === 'write' || toolName === 'edit';
}

export function getToolPath(args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null) {
		return undefined;
	}
	const path = (args as { path?: unknown; file_path?: unknown }).path ?? (args as { file_path?: unknown }).file_path;
	return typeof path === 'string' ? path : undefined;
}

export function getToolBody(toolName: string | undefined, args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null || toolName === 'read') {
		return undefined;
	}

	if (toolName === 'write') {
		const content = (args as { content?: unknown }).content;
		return typeof content === 'string' ? content : undefined;
	}

	if (toolName === 'edit') {
		return getEditPreview(args);
	}

	return undefined;
}

function getEditPreview(args: unknown): string | undefined {
	const edits = (args as { edits?: unknown }).edits;
	if (!Array.isArray(edits)) {
		return undefined;
	}
	return edits
		.map((edit, index) => {
			const oldText = typeof (edit as { oldText?: unknown }).oldText === 'string' ? (edit as { oldText: string }).oldText : '';
			const newText = typeof (edit as { newText?: unknown }).newText === 'string' ? (edit as { newText: string }).newText : '';
			return [`@@ edit ${index + 1} @@`, ...oldText.split('\n').map((line) => `-${line}`), ...newText.split('\n').map((line) => `+${line}`)].join('\n');
		})
		.join('\n');
}

export function getToolResultText(result: RpcEvent['result']): string | undefined {
	const text = result?.content
		?.filter((content) => content.type === 'text')
		.map((content) => content.text ?? '')
		.join('\n')
		.trim();
	return text || undefined;
}
