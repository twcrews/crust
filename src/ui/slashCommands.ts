import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SlashCommand } from '../pi/rpcTypes';
import { errorMessage } from '../utils/errorMessage';
import type { CrustLogLevel } from '../utils/crustLogger';

const execFileAsync = promisify(execFile);

type LogFn = (message: string, details?: unknown, level?: CrustLogLevel) => void;

export function dedupeSlashCommands(commands: SlashCommand[]): SlashCommand[] {
	const byName = new Map<string, SlashCommand>();
	for (const command of commands) {
		if (!byName.has(command.name)) {
			byName.set(command.name, command);
		}
	}
	return [...byName.values()];
}

export async function getBuiltinSlashCommands(log: LogFn): Promise<SlashCommand[]> {
	try {
		const { stdout } = await execFileAsync('which', ['pi']);
		const piCliPath = await realpath(stdout.trim());
		const source = await readFile(join(dirname(piCliPath), 'core', 'slash-commands.js'), 'utf8');
		const commands: SlashCommand[] = [];
		for (const match of source.matchAll(/\{\s*name:\s*"([^"]+)",\s*description:\s*(?:"([^"]*)"|`([^`]*)`)\s*\}/g)) {
			commands.push({ name: match[1], description: (match[2] ?? match[3]).replace(/\$\{APP_NAME\}/g, 'Pi'), source: 'builtin' });
		}
		return commands.length ? commands : fallbackCommands;
	} catch (error) {
		log('Failed to load Pi builtin slash commands', { error: errorMessage(error) }, 'warn');
		return fallbackCommands;
	}
}

const fallbackCommands: SlashCommand[] = [{ name: 'new', description: 'Start a new session', source: 'builtin' }];
