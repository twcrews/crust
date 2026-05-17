import type { RpcEvent } from '../pi/rpcTypes';

export function isFileTool(toolName: string | undefined): boolean {
	return toolName === 'read' || toolName === 'write' || toolName === 'edit';
}

export function isRenderableTool(toolName: string | undefined): boolean {
	return isFileTool(toolName) || toolName === 'bash';
}

export function getToolPath(args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null) {
		return undefined;
	}
	const path = (args as { path?: unknown; file_path?: unknown }).path ?? (args as { file_path?: unknown }).file_path;
	return typeof path === 'string' ? path : undefined;
}

export function getToolHeaderDetail(toolName: string | undefined, args: unknown, result?: RpcEvent['result']): string | undefined {
	if (toolName === 'bash') {
		return getBashCommand(args);
	}

	const path = getToolPath(args);
	if (toolName !== 'read' || !path) {
		return path;
	}

	if (isEntireFileRead(args, result)) {
		return path;
	}

	const lineRange = getReadLineRange(args);
	return lineRange ? `${path} ${lineRange}` : path;
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

	if (toolName === 'bash') {
		const command = getBashCommand(args);
		return command ? `$ ${command}` : undefined;
	}

	return undefined;
}

function getBashCommand(args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null) {
		return undefined;
	}
	const command = (args as { command?: unknown; cmd?: unknown }).command ?? (args as { cmd?: unknown }).cmd;
	return typeof command === 'string' ? command : undefined;
}

function isEntireFileRead(args: unknown, result: RpcEvent['result'] | undefined): boolean {
	if (typeof args !== 'object' || args === null) {
		return true;
	}

	const record = args as { offset?: unknown; limit?: unknown };
	const startLine = getPositiveInteger(record.offset) ?? 1;
	if (record.limit === undefined) {
		return startLine === 1;
	}

	if (startLine !== 1 || result === undefined) {
		return false;
	}

	const truncation = result.details?.truncation;
	if (typeof truncation === 'object' && truncation !== null && (truncation as { truncated?: unknown }).truncated === true) {
		return false;
	}

	const text = getToolResultText(result);
	return !text || !/(\bmore lines\b|Use offset=|Showing lines \d+-\d+ of \d+)/.test(text);
}

function getReadLineRange(args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null) {
		return undefined;
	}

	const record = args as { offset?: unknown; limit?: unknown };
	if (record.offset === undefined && record.limit === undefined) {
		return undefined;
	}

	const startLine = getPositiveInteger(record.offset) ?? 1;
	const limit = getPositiveInteger(record.limit);
	if (limit === undefined) {
		return `line ${startLine}`;
	}

	const endLine = startLine + limit - 1;
	return endLine === startLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function getPositiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
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
	if (text) {
		return text;
	}

	const details = result?.details;
	if (!details) {
		return undefined;
	}
	const detailText = ['output', 'stdout', 'stderr']
		.map((key) => details[key])
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		.join('\n')
		.trim();
	return detailText || undefined;
}
