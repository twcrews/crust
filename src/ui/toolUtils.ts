import type { ToolResult } from '../pi/rpcTypes';

export function isFileTool(toolName: string | undefined): boolean {
	return toolName === 'read' || toolName === 'write' || toolName === 'edit';
}

export function isRenderableTool(toolName: string | undefined): boolean {
	return isFileTool(toolName) || toolName === 'bash';
}

function isRecord(args: unknown): args is Record<string, unknown> {
	return typeof args === 'object' && args !== null;
}

export function getToolPath(args: unknown): string | undefined {
	if (!isRecord(args)) {
		return undefined;
	}
	const path = args.path ?? args.file_path;
	return typeof path === 'string' ? path : undefined;
}

export function getToolHeaderDetail(toolName: string | undefined, args: unknown, result?: ToolResult): string | undefined {
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
	if (!isRecord(args) || toolName === 'read') {
		return undefined;
	}

	if (toolName === 'write') {
		const content = args.content;
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
	if (!isRecord(args)) {
		return undefined;
	}
	const command = args.command ?? args.cmd;
	return typeof command === 'string' ? command : undefined;
}

function isEntireFileRead(args: unknown, result: ToolResult | undefined): boolean {
	if (!isRecord(args)) {
		return true;
	}

	const startLine = getPositiveInteger(args.offset) ?? 1;
	if (args.limit === undefined) {
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
	if (!isRecord(args)) {
		return undefined;
	}

	if (args.offset === undefined && args.limit === undefined) {
		return undefined;
	}

	const startLine = getPositiveInteger(args.offset) ?? 1;
	const limit = getPositiveInteger(args.limit);
	if (limit === undefined) {
		return `line ${startLine}`;
	}

	const endLine = startLine + limit - 1;
	return endLine === startLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function getPositiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function getEditPreview(args: Record<string, unknown>): string | undefined {
	const edits = args.edits;
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

export function getToolResultText(result: ToolResult | undefined): string | undefined {
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
