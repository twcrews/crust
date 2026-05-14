import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { PiRpcClient } from '../pi/piRpcClient';
import type { SessionInfo } from './chatTypes';
import { extractRestoredPrompt } from './ideContext';
import { getEntryTimestamp, getMessageRole, getMessageText, getMessageTimestamp, parseJsonObject } from './messageUtils';

export async function listSessions(client: PiRpcClient, cwd: string | undefined): Promise<SessionInfo[]> {
	const sessionDir = await getSessionDir(client, cwd);
	if (!sessionDir || !existsSync(sessionDir)) {
		return [];
	}

	const entries = await readdir(sessionDir);
	const sessions = await Promise.all(
		entries
			.filter((entry) => entry.endsWith('.jsonl'))
			.map((entry) => readSessionInfo(join(sessionDir, entry))),
	);
	return sessions
		.filter((session): session is SessionInfo => Boolean(session))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function getSessionDir(client: PiRpcClient, cwd: string | undefined): Promise<string | undefined> {
	const state = await client.getState();
	const sessionFile = typeof (state as { sessionFile?: unknown } | undefined)?.sessionFile === 'string'
		? (state as { sessionFile: string }).sessionFile
		: undefined;
	if (sessionFile) {
		return dirname(sessionFile);
	}
	const workspaceCwd = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceCwd) {
		return undefined;
	}
	const root = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions');
	return join(root, `--${workspaceCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

async function readSessionInfo(path: string): Promise<SessionInfo | undefined> {
	try {
		const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
		const entries = content
			.trim()
			.split('\n')
			.map((line) => parseJsonObject(line))
			.filter((entry): entry is Record<string, unknown> => Boolean(entry));
		const header = entries[0];
		if (header?.type !== 'session') {
			return undefined;
		}

		let name: string | undefined;
		let firstMessage = '(no messages)';
		let messageCount = 0;
		let modified = stats.mtime;
		for (const entry of entries) {
			if (entry.type === 'session_info') {
				name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
			}
			if (entry.type !== 'message') {
				continue;
			}
			messageCount++;
			const message = entry.message;
			const role = getMessageRole(message);
			const text = getMessageText(message).trim();
			if (role === 'user' && firstMessage === '(no messages)' && text) {
				firstMessage = extractRestoredPrompt(text).text;
			}
			const timestamp = getMessageTimestamp(message) ?? getEntryTimestamp(entry);
			if (timestamp && timestamp > modified.getTime()) {
				modified = new Date(timestamp);
			}
		}

		return { path, name, firstMessage, modified, messageCount };
	} catch {
		return undefined;
	}
}
