import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { Model } from '../pi/rpcTypes';
import { getMessageRole, parseJsonObject } from './messageUtils';

const execFileAsync = promisify(execFile);

export function getFileBackedCwd(filePath: string): string | undefined {
	const parts = filePath.split(/[\\/]+/);
	const piIndex = parts.lastIndexOf('.pi');
	if (piIndex > 0) {
		return parts.slice(0, piIndex).join('/') || (filePath.startsWith('/') ? '/' : undefined);
	}
	return dirname(filePath);
}

export function getInitialCwd(): string | undefined {
	const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
	if (activeDocumentUri?.scheme === 'file') {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocumentUri)?.uri.fsPath;
		if (workspaceFolder) {
			return workspaceFolder;
		}

		return getFileBackedCwd(activeDocumentUri.fsPath) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function getWorkspaceStatus(cwd: string | undefined): Promise<string> {
	if (!cwd) {
		return 'No workspace folder';
	}

	const workspaceName = basename(cwd) || cwd;
	const branch = await getGitBranch(cwd);
	return branch ? `${workspaceName} - ${branch}` : `${workspaceName} - no branch`;
}

async function getGitBranch(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current']);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function formatSessionDate(date: Date): string {
	return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

export function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function modelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

export function getModelContextWindow(model: Model | null | undefined): number | undefined {
	const contextWindow = (model as { contextWindow?: unknown } | null | undefined)?.contextWindow;
	return typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? contextWindow : undefined;
}

export function getSessionPath(state: unknown): string | undefined {
	const sessionFile = (state as { sessionFile?: unknown } | undefined)?.sessionFile;
	return typeof sessionFile === 'string' ? sessionFile : undefined;
}

export function createId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getPostLogDetails(message: unknown): Record<string, unknown> | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const record = message as { type?: unknown; id?: unknown; role?: unknown; text?: unknown; status?: unknown };
	return {
		type: record.type,
		id: record.id,
		role: record.role,
		status: record.status,
		textLength: typeof record.text === 'string' ? record.text.length : undefined,
	};
}

export function formatErrorForChat(message: string): string {
	const pretty = tryPrettyPrintJsonError(message);
	return `Error: ${pretty}`;
}

function tryPrettyPrintJsonError(message: string): string {
	const jsonStart = [...message]
		.map((char, index) => (char === '{' || char === '[' ? index : -1))
		.find((index) => index >= 0);
	if (jsonStart === undefined) {
		return message;
	}

	const prefix = message.slice(0, jsonStart).trim();
	const jsonText = message.slice(jsonStart).trim();
	try {
		const parsed = JSON.parse(jsonText) as unknown;
		const formattedJson = JSON.stringify(parsed, null, 2);
		return `${prefix ? `${prefix}\n` : ''}\n\`\`\`json\n${formattedJson}\n\`\`\``;
	} catch {
		return message;
	}
}

export function getLastAssistantMessage(messages: unknown): unknown {
	if (!Array.isArray(messages)) {
		return undefined;
	}
	return messages.slice().reverse().find((message) => getMessageRole(message) === 'assistant');
}

export function getAssistantErrorMessage(message: unknown): string | undefined {
	if (
		getMessageRole(message) !== 'assistant'
		|| typeof message !== 'object'
		|| message === null
		|| (message as { stopReason?: unknown }).stopReason !== 'error'
	) {
		return undefined;
	}
	const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
	return typeof errorMessage === 'string' && errorMessage ? errorMessage : 'Unknown error';
}

export function isAbortedAssistantMessage(message: unknown): boolean {
	return getMessageRole(message) === 'assistant'
		&& typeof message === 'object'
		&& message !== null
		&& (message as { stopReason?: unknown }).stopReason === 'aborted';
}

export function getAbortMessage(message: unknown): string {
	if (typeof message !== 'object' || message === null) {
		return 'Operation aborted';
	}
	const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
	return typeof errorMessage === 'string' && errorMessage && errorMessage !== 'Request was aborted'
		? errorMessage
		: 'Operation aborted';
}

export function hasMessageUsage(message: unknown): boolean {
	if (typeof message !== 'object' || message === null) {
		return false;
	}
	const record = message as { usage?: unknown; message?: unknown };
	const usage = record.usage ?? (typeof record.message === 'object' && record.message !== null ? (record.message as { usage?: unknown }).usage : undefined);
	return typeof usage === 'object' && usage !== null;
}

export function getMessageContentAt(message: unknown, contentIndex: number | undefined): unknown {
	if (typeof message !== 'object' || message === null || contentIndex === undefined) {
		return undefined;
	}
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content[contentIndex] : undefined;
}

export function toolElementId(toolCallId: string | undefined): string {
	return `tool-${toolCallId ?? createId('unknown')}`;
}

export function getLastModelFromSessionText(text: string, models: Model[]): Model | undefined {
	let latest: Model | undefined;
	for (const line of text.split(/\r?\n/)) {
		const entry = parseJsonObject(line);
		if (!entry) {
			continue;
		}
		if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
			latest = findKnownModel(models, entry.provider, entry.modelId) ?? { provider: entry.provider, id: entry.modelId };
			continue;
		}
		const message = entry.message;
		if (entry.type === 'message' && getMessageRole(message) === 'assistant' && typeof (message as { provider?: unknown }).provider === 'string' && typeof (message as { model?: unknown }).model === 'string') {
			const provider = (message as { provider: string }).provider;
			const modelId = (message as { model: string }).model;
			latest = findKnownModel(models, provider, modelId) ?? { provider, id: modelId };
		}
	}
	return latest;
}

function findKnownModel(models: Model[], provider: string, modelId: string): Model | undefined {
	return models.find((model) => model.provider === provider && model.id === modelId);
}
