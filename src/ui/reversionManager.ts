import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

const reversionVersion = 1;
const unsavedSessionKey = '__unsaved_session__';

export type FileSnapshot = {
	exists: boolean;
	content?: string;
	hash?: string;
	lineCount?: number;
};

export type FileMutation = {
	path: string;
	absolutePath: string;
	before: FileSnapshot;
	after?: FileSnapshot;
	toolCallId?: string;
	toolName: 'write' | 'edit';
};

export type UnsafeMutation = {
	toolCallId?: string;
	toolName: string;
	description?: string;
	timestamp: string;
};

export type ReversionCheckpointSummary = {
	id: string;
	sessionPath?: string;
	promptMessageId: string;
	promptText: string;
	promptIndex: number;
	createdAt: string;
	workspaceRoot: string;
	mutationCount: number;
	unsafeMutationCount: number;
};

export type ReversionCheckpoint = ReversionCheckpointSummary & {
	version: typeof reversionVersion;
	mutations: FileMutation[];
	unsafeMutations: UnsafeMutation[];
};

type SessionReversionIndex = {
	sessionPath?: string;
	checkpoints: ReversionCheckpointSummary[];
};

type WorkspaceReversionIndex = {
	workspaceRoot: string;
	sessions: Record<string, SessionReversionIndex>;
};

type ReversionIndex = {
	version: typeof reversionVersion;
	workspaces: Record<string, WorkspaceReversionIndex>;
};

export type CreateCheckpointArgs = {
	sessionPath?: string;
	promptMessageId?: string;
	promptText: string;
	promptIndex: number;
	workspaceRoot?: string;
};

type ReversionStorageContext = {
	globalStorageUri: vscode.Uri;
	workspaceStorageUri?: vscode.Uri;
};

export class ReversionManager {
	private readonly storageRoot: string;
	private readonly defaultWorkspaceRoot: string;

	constructor(context: ReversionStorageContext, workspaceRoot: string | undefined) {
		this.storageRoot = join((context.workspaceStorageUri ?? context.globalStorageUri).fsPath, 'reversion');
		this.defaultWorkspaceRoot = workspaceRoot ?? '';
	}

	async createCheckpoint(args: CreateCheckpointArgs): Promise<ReversionCheckpointSummary> {
		const workspaceRoot = args.workspaceRoot ?? this.defaultWorkspaceRoot;
		const checkpoint: ReversionCheckpoint = {
			version: reversionVersion,
			id: createCheckpointId(),
			sessionPath: args.sessionPath,
			promptMessageId: args.promptMessageId ?? createCheckpointId('prompt'),
			promptText: args.promptText,
			promptIndex: args.promptIndex,
			createdAt: new Date().toISOString(),
			workspaceRoot,
			mutationCount: 0,
			unsafeMutationCount: 0,
			mutations: [],
			unsafeMutations: [],
		};

		await this.writeCheckpoint(checkpoint);
		await this.upsertCheckpointSummary(checkpoint);
		return toSummary(checkpoint);
	}

	async getCheckpoint(checkpointId: string): Promise<ReversionCheckpoint | undefined> {
		const file = this.getCheckpointPath(checkpointId);
		if (!existsSync(file)) {
			return undefined;
		}

		const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
		return isCheckpoint(parsed) ? parsed : undefined;
	}

	async listCheckpoints(sessionPath?: string, workspaceRoot = this.defaultWorkspaceRoot): Promise<ReversionCheckpointSummary[]> {
		const index = await this.readIndex();
		const workspace = index.workspaces[getWorkspaceKey(workspaceRoot)];
		if (!workspace) {
			return [];
		}

		if (sessionPath !== undefined) {
			return workspace.sessions[getSessionKey(sessionPath)]?.checkpoints ?? [];
		}

		return Object.values(workspace.sessions).flatMap((session) => session.checkpoints);
	}

	async readFileSnapshot(absolutePath: string): Promise<FileSnapshot> {
		try {
			const content = await readFile(absolutePath, 'utf8');
			return {
				exists: true,
				content,
				hash: hashContent(content),
				lineCount: countLines(content),
			};
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return { exists: false };
			}
			throw error;
		}
	}

	async ensureStorage(): Promise<void> {
		await mkdir(this.getCheckpointsDirectory(), { recursive: true });
	}

	private async upsertCheckpointSummary(checkpoint: ReversionCheckpoint): Promise<void> {
		const index = await this.readIndex();
		const workspaceKey = getWorkspaceKey(checkpoint.workspaceRoot);
		const sessionKey = getSessionKey(checkpoint.sessionPath);
		const workspace = index.workspaces[workspaceKey] ?? { workspaceRoot: checkpoint.workspaceRoot, sessions: {} };
		const session = workspace.sessions[sessionKey] ?? { sessionPath: checkpoint.sessionPath, checkpoints: [] };
		const summary = toSummary(checkpoint);

		session.checkpoints = [...session.checkpoints.filter((existing) => existing.id !== checkpoint.id), summary]
			.sort((left, right) => left.promptIndex - right.promptIndex || left.createdAt.localeCompare(right.createdAt));
		workspace.sessions[sessionKey] = session;
		index.workspaces[workspaceKey] = workspace;
		await this.writeIndex(index);
	}

	private async readIndex(): Promise<ReversionIndex> {
		const file = this.getIndexPath();
		if (!existsSync(file)) {
			return createEmptyIndex();
		}

		try {
			const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
			return isIndex(parsed) ? parsed : createEmptyIndex();
		} catch {
			return createEmptyIndex();
		}
	}

	private async writeIndex(index: ReversionIndex): Promise<void> {
		await mkdir(dirname(this.getIndexPath()), { recursive: true });
		await writeFile(this.getIndexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
	}

	private async writeCheckpoint(checkpoint: ReversionCheckpoint): Promise<void> {
		await this.ensureStorage();
		await writeFile(this.getCheckpointPath(checkpoint.id), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
	}

	private getIndexPath(): string {
		return join(this.storageRoot, 'index.json');
	}

	private getCheckpointsDirectory(): string {
		return join(this.storageRoot, 'checkpoints');
	}

	private getCheckpointPath(checkpointId: string): string {
		return join(this.getCheckpointsDirectory(), `${checkpointId}.json`);
	}
}

export function hashContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

export function countLines(content: string): number {
	if (!content) {
		return 0;
	}
	return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

function createEmptyIndex(): ReversionIndex {
	return { version: reversionVersion, workspaces: {} };
}

function toSummary(checkpoint: ReversionCheckpoint): ReversionCheckpointSummary {
	return {
		id: checkpoint.id,
		sessionPath: checkpoint.sessionPath,
		promptMessageId: checkpoint.promptMessageId,
		promptText: checkpoint.promptText,
		promptIndex: checkpoint.promptIndex,
		createdAt: checkpoint.createdAt,
		workspaceRoot: checkpoint.workspaceRoot,
		mutationCount: checkpoint.mutationCount,
		unsafeMutationCount: checkpoint.unsafeMutationCount,
	};
}

function createCheckpointId(prefix = 'checkpoint'): string {
	return `${prefix}-${randomUUID()}`;
}

function getWorkspaceKey(workspaceRoot: string): string {
	return hashContent(workspaceRoot || '__no_workspace__');
}

function getSessionKey(sessionPath: string | undefined): string {
	return sessionPath ? hashContent(sessionPath) : unsavedSessionKey;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === 'object' && error !== null && 'code' in error;
}

function isIndex(value: unknown): value is ReversionIndex {
	if (!isRecord(value) || value.version !== reversionVersion || !isRecord(value.workspaces)) {
		return false;
	}
	return true;
}

function isCheckpoint(value: unknown): value is ReversionCheckpoint {
	return isRecord(value)
		&& value.version === reversionVersion
		&& typeof value.id === 'string'
		&& typeof value.promptMessageId === 'string'
		&& typeof value.promptText === 'string'
		&& typeof value.promptIndex === 'number'
		&& typeof value.createdAt === 'string'
		&& typeof value.workspaceRoot === 'string'
		&& typeof value.mutationCount === 'number'
		&& typeof value.unsafeMutationCount === 'number'
		&& Array.isArray(value.mutations)
		&& Array.isArray(value.unsafeMutations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
