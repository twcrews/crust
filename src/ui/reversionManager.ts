import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import * as vscode from 'vscode';

const reversionVersion = 2;
const legacyReversionVersion = 1;
const maxCheckpointsPerSession = 100;
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

export type FileMutationArgs = {
	toolCallId?: string;
	toolName: 'write' | 'edit';
	filePath: string;
	workspaceRoot?: string;
};

export type UnsafeMutationArgs = {
	toolCallId?: string;
	toolName: string;
	description?: string;
};

export type ResetFileChange = {
	path: string;
	absolutePath: string;
	target: FileSnapshot;
	expectedCurrent?: FileSnapshot;
	current?: FileSnapshot;
};

export type ResetStats = {
	affectedFileCount: number;
	addedLineCount: number;
	removedLineCount: number;
};

export type ResetConflict = {
	path: string;
	reason: 'current-hash-mismatch' | 'missing-snapshot' | 'io-error';
	message: string;
};

export type ResetPlan = {
	checkpointId: string;
	affectedFiles: ResetFileChange[];
	stats: ResetStats;
	conflicts: ResetConflict[];
	unsafeMutationCount: number;
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
		return normalizeCheckpoint(parsed);
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

	async updateCheckpointSessionPath(checkpointId: string, sessionPath: string): Promise<void> {
		const checkpoint = await this.getCheckpoint(checkpointId);
		if (!checkpoint || checkpoint.sessionPath === sessionPath) {
			return;
		}
		checkpoint.sessionPath = sessionPath;
		await this.persistCheckpointUpdate(checkpoint);
	}

	async recordFileMutationStart(checkpointId: string, args: FileMutationArgs): Promise<void> {
		const checkpoint = await this.getCheckpoint(checkpointId);
		if (!checkpoint) {
			return;
		}

		const file = this.resolveMutationPath(args.filePath, args.workspaceRoot ?? checkpoint.workspaceRoot);
		if (checkpoint.mutations.some((mutation) => mutation.toolCallId === args.toolCallId && args.toolCallId !== undefined || mutation.absolutePath === file.absolutePath)) {
			return;
		}

		checkpoint.mutations.push({
			path: file.relativePath,
			absolutePath: file.absolutePath,
			before: await this.readFileSnapshot(file.absolutePath),
			toolCallId: args.toolCallId,
			toolName: args.toolName,
		});
		checkpoint.mutationCount = checkpoint.mutations.filter((mutation) => mutation.after !== undefined).length;
		await this.persistCheckpointUpdate(checkpoint);
	}

	async recordFileMutationEnd(checkpointId: string, args: FileMutationArgs): Promise<void> {
		const checkpoint = await this.getCheckpoint(checkpointId);
		if (!checkpoint) {
			return;
		}

		const file = this.resolveMutationPath(args.filePath, args.workspaceRoot ?? checkpoint.workspaceRoot);
		const mutation = checkpoint.mutations.find((candidate) => candidate.toolCallId === args.toolCallId && args.toolCallId !== undefined || candidate.absolutePath === file.absolutePath);
		if (!mutation) {
			checkpoint.mutations.push({
				path: file.relativePath,
				absolutePath: file.absolutePath,
				before: await this.readFileSnapshot(file.absolutePath),
				after: await this.readFileSnapshot(file.absolutePath),
				toolCallId: args.toolCallId,
				toolName: args.toolName,
			});
		} else {
			mutation.after = await this.readFileSnapshot(file.absolutePath);
		}
		checkpoint.mutationCount = checkpoint.mutations.filter((item) => item.after !== undefined).length;
		await this.persistCheckpointUpdate(checkpoint);
	}

	async recordUnsafeMutation(checkpointId: string, args: UnsafeMutationArgs): Promise<void> {
		const checkpoint = await this.getCheckpoint(checkpointId);
		if (!checkpoint) {
			return;
		}
		if (args.toolCallId && checkpoint.unsafeMutations.some((mutation) => mutation.toolCallId === args.toolCallId)) {
			return;
		}
		checkpoint.unsafeMutations.push({
			toolCallId: args.toolCallId,
			toolName: args.toolName,
			description: args.description,
			timestamp: new Date().toISOString(),
		});
		checkpoint.unsafeMutationCount = checkpoint.unsafeMutations.length;
		await this.persistCheckpointUpdate(checkpoint);
	}

	async applyResetPlan(plan: ResetPlan): Promise<ResetPlan> {
		const freshPlan = await this.buildResetPlan(plan.checkpointId);
		if (freshPlan.conflicts.length) {
			throw new Error(`Cannot reset code with ${freshPlan.conflicts.length} unresolved conflict${freshPlan.conflicts.length === 1 ? '' : 's'}.`);
		}
		if (!freshPlan.affectedFiles.length) {
			return freshPlan;
		}

		const safetyCheckpoint = await this.createSafetyCheckpoint(freshPlan);
		for (const change of freshPlan.affectedFiles) {
			if (change.target.exists) {
				await mkdir(dirname(change.absolutePath), { recursive: true });
				await writeFile(change.absolutePath, change.target.content ?? '', 'utf8');
			} else {
				await rm(change.absolutePath, { force: true });
			}
			await this.recordFileMutationEnd(safetyCheckpoint.id, { toolCallId: `reset:${change.absolutePath}`, toolName: 'edit', filePath: change.absolutePath, workspaceRoot: safetyCheckpoint.workspaceRoot });
		}
		return freshPlan;
	}

	async buildResetPlan(checkpointId: string): Promise<ResetPlan> {
		const targetCheckpoint = await this.getCheckpoint(checkpointId);
		if (!targetCheckpoint) {
			throw new Error(`Reversion checkpoint not found: ${checkpointId}`);
		}

		const summaries = (await this.listSessionCheckpoints(targetCheckpoint.sessionPath, targetCheckpoint.workspaceRoot))
			.filter((summary) => summary.promptIndex >= targetCheckpoint.promptIndex)
			.sort((left, right) => left.promptIndex - right.promptIndex || left.createdAt.localeCompare(right.createdAt));
		const checkpoints = (await Promise.all(summaries.map((summary) => this.getCheckpoint(summary.id))))
			.filter((checkpoint): checkpoint is ReversionCheckpoint => checkpoint !== undefined);
		const changesByPath = new Map<string, ResetFileChange>();
		let unsafeMutationCount = 0;

		for (const checkpoint of checkpoints) {
			unsafeMutationCount += checkpoint.unsafeMutationCount;
			for (const mutation of checkpoint.mutations) {
				const existing = changesByPath.get(mutation.absolutePath);
				if (!existing) {
					changesByPath.set(mutation.absolutePath, {
						path: mutation.path,
						absolutePath: mutation.absolutePath,
						target: mutation.before,
						expectedCurrent: mutation.after,
					});
					continue;
				}
				existing.expectedCurrent = mutation.after ?? existing.expectedCurrent;
			}
		}

		const affectedFiles: ResetFileChange[] = [];
		const conflicts: ResetConflict[] = [];
		let addedLineCount = 0;
		let removedLineCount = 0;

		for (const change of changesByPath.values()) {
			if (!change.expectedCurrent) {
				conflicts.push({ path: change.path, reason: 'missing-snapshot', message: `Missing post-change snapshot for ${change.path}.` });
				continue;
			}
			try {
				const current = await this.readFileSnapshot(change.absolutePath);
				change.current = current;
				if (snapshotsEqual(current, change.target)) {
					continue;
				}
				if (!snapshotsEqual(current, change.expectedCurrent)) {
					conflicts.push({ path: change.path, reason: 'current-hash-mismatch', message: `${change.path} has changed since Crust last tracked it.` });
					continue;
				}
				const lineStats = getLineChangeStats(current, change.target);
				addedLineCount += lineStats.added;
				removedLineCount += lineStats.removed;
				affectedFiles.push(change);
			} catch (error) {
				conflicts.push({ path: change.path, reason: 'io-error', message: `Unable to inspect ${change.path}: ${error instanceof Error ? error.message : String(error)}` });
			}
		}

		return {
			checkpointId,
			affectedFiles,
			stats: {
				affectedFileCount: affectedFiles.length,
				addedLineCount,
				removedLineCount,
			},
			conflicts,
			unsafeMutationCount,
		};
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

	private async createSafetyCheckpoint(plan: ResetPlan): Promise<ReversionCheckpointSummary> {
		const targetCheckpoint = await this.getCheckpoint(plan.checkpointId);
		if (!targetCheckpoint) {
			throw new Error(`Reversion checkpoint not found: ${plan.checkpointId}`);
		}
		const summaries = await this.listSessionCheckpoints(targetCheckpoint.sessionPath, targetCheckpoint.workspaceRoot);
		const promptIndex = Math.max(-1, ...summaries.map((summary) => summary.promptIndex)) + 1;
		const checkpoint = await this.createCheckpoint({
			sessionPath: targetCheckpoint.sessionPath,
			promptText: `Before reset to prompt ${targetCheckpoint.promptIndex + 1}`,
			promptIndex,
			workspaceRoot: targetCheckpoint.workspaceRoot,
		});
		for (const change of plan.affectedFiles) {
			await this.recordFileMutationStart(checkpoint.id, { toolCallId: `reset:${change.absolutePath}`, toolName: 'edit', filePath: change.absolutePath, workspaceRoot: targetCheckpoint.workspaceRoot });
		}
		return checkpoint;
	}

	private async persistCheckpointUpdate(checkpoint: ReversionCheckpoint): Promise<void> {
		await this.writeCheckpoint(checkpoint);
		await this.upsertCheckpointSummary(checkpoint);
	}

	private async listSessionCheckpoints(sessionPath: string | undefined, workspaceRoot: string): Promise<ReversionCheckpointSummary[]> {
		const index = await this.readIndex();
		const workspace = index.workspaces[getWorkspaceKey(workspaceRoot)];
		return workspace?.sessions[getSessionKey(sessionPath)]?.checkpoints ?? [];
	}

	private resolveMutationPath(filePath: string, workspaceRoot: string): { absolutePath: string; relativePath: string } {
		const absolutePath = resolve(workspaceRoot || this.defaultWorkspaceRoot || process.cwd(), filePath);
		const relativePath = workspaceRoot ? normalizePath(relative(workspaceRoot, absolutePath)) : normalizePath(filePath);
		return { absolutePath, relativePath };
	}

	private async upsertCheckpointSummary(checkpoint: ReversionCheckpoint): Promise<void> {
		const index = await this.readIndex();
		const workspaceKey = getWorkspaceKey(checkpoint.workspaceRoot);
		const sessionKey = getSessionKey(checkpoint.sessionPath);
		const workspace = index.workspaces[workspaceKey] ?? { workspaceRoot: checkpoint.workspaceRoot, sessions: {} };
		for (const existingSession of Object.values(workspace.sessions)) {
			existingSession.checkpoints = existingSession.checkpoints.filter((existing) => existing.id !== checkpoint.id);
		}
		const session = workspace.sessions[sessionKey] ?? { sessionPath: checkpoint.sessionPath, checkpoints: [] };
		const summary = toSummary(checkpoint);

		const sortedCheckpoints = [...session.checkpoints, summary]
			.sort((left, right) => left.promptIndex - right.promptIndex || left.createdAt.localeCompare(right.createdAt));
		const prunedCheckpoints = sortedCheckpoints.slice(0, Math.max(0, sortedCheckpoints.length - maxCheckpointsPerSession));
		session.checkpoints = sortedCheckpoints.slice(-maxCheckpointsPerSession);
		await Promise.all(prunedCheckpoints.map((pruned) => rm(this.getCheckpointPath(pruned.id), { force: true })));
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
			return isIndex(parsed) ? normalizeIndex(parsed) : createEmptyIndex();
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

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
	if (left.exists !== right.exists) {
		return false;
	}
	if (!left.exists) {
		return true;
	}
	return left.hash !== undefined && left.hash === right.hash;
}

function getLineChangeStats(current: FileSnapshot, target: FileSnapshot): { added: number; removed: number } {
	if (!current.exists && !target.exists) {
		return { added: 0, removed: 0 };
	}
	if (!current.exists) {
		return { added: target.lineCount ?? countLines(target.content ?? ''), removed: 0 };
	}
	if (!target.exists) {
		return { added: 0, removed: current.lineCount ?? countLines(current.content ?? '') };
	}
	return diffLineCounts(splitLines(current.content ?? ''), splitLines(target.content ?? ''));
}

function splitLines(content: string): string[] {
	if (!content) {
		return [];
	}
	return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

function diffLineCounts(from: string[], to: string[]): { added: number; removed: number } {
	const previous = new Array<number>(to.length + 1).fill(0);
	const current = new Array<number>(to.length + 1).fill(0);
	for (let fromIndex = 1; fromIndex <= from.length; fromIndex++) {
		for (let toIndex = 1; toIndex <= to.length; toIndex++) {
			current[toIndex] = from[fromIndex - 1] === to[toIndex - 1]
				? previous[toIndex - 1] + 1
				: Math.max(previous[toIndex], current[toIndex - 1]);
		}
		previous.splice(0, previous.length, ...current);
		current.fill(0);
	}
	const common = previous[to.length] ?? 0;
	return { added: to.length - common, removed: from.length - common };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === 'object' && error !== null && 'code' in error;
}

function isIndex(value: unknown): value is ReversionIndex {
	if (!isRecord(value) || value.version !== reversionVersion && value.version !== legacyReversionVersion || !isRecord(value.workspaces)) {
		return false;
	}
	return true;
}

function normalizeIndex(index: ReversionIndex): ReversionIndex {
	for (const workspace of Object.values(index.workspaces)) {
		for (const session of Object.values(workspace.sessions)) {
			session.checkpoints = session.checkpoints
				.map((summary) => normalizeCheckpointSummary(summary, index.version))
				.filter((summary): summary is ReversionCheckpointSummary => summary !== undefined);
		}
	}
	return index;
}

function normalizeCheckpoint(value: unknown): ReversionCheckpoint | undefined {
	if (!isRecord(value)
		|| value.version !== reversionVersion && value.version !== legacyReversionVersion
		|| typeof value.id !== 'string'
		|| typeof value.promptMessageId !== 'string'
		|| typeof value.promptText !== 'string'
		|| typeof value.createdAt !== 'string'
		|| typeof value.workspaceRoot !== 'string'
		|| typeof value.mutationCount !== 'number'
		|| typeof value.unsafeMutationCount !== 'number'
		|| !Array.isArray(value.mutations)
		|| !Array.isArray(value.unsafeMutations)) {
		return undefined;
	}
	const promptIndex = getStoredPromptIndex(value, value.version);
	if (promptIndex === undefined) {
		return undefined;
	}
	const { promptIndex: _promptIndex, version: _version, ...checkpoint } = value;
	return { ...checkpoint, version: reversionVersion, promptIndex } as ReversionCheckpoint;
}

function normalizeCheckpointSummary(value: unknown, version: unknown): ReversionCheckpointSummary | undefined {
	if (!isRecord(value)
		|| typeof value.id !== 'string'
		|| typeof value.promptMessageId !== 'string'
		|| typeof value.promptText !== 'string'
		|| typeof value.createdAt !== 'string'
		|| typeof value.workspaceRoot !== 'string'
		|| typeof value.mutationCount !== 'number'
		|| typeof value.unsafeMutationCount !== 'number') {
		return undefined;
	}
	const promptIndex = getStoredPromptIndex(value, version);
	if (promptIndex === undefined) {
		return undefined;
	}
	return {
		id: value.id,
		sessionPath: typeof value.sessionPath === 'string' ? value.sessionPath : undefined,
		promptMessageId: value.promptMessageId,
		promptText: value.promptText,
		promptIndex,
		createdAt: value.createdAt,
		workspaceRoot: value.workspaceRoot,
		mutationCount: value.mutationCount,
		unsafeMutationCount: value.unsafeMutationCount,
	};
}

function getStoredPromptIndex(value: Record<string, unknown>, version: unknown): number | undefined {
	if (typeof value.promptIndex !== 'number') {
		return undefined;
	}
	return version === legacyReversionVersion ? Math.max(0, value.promptIndex - 1) : value.promptIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
