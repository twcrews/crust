import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SlashCommand } from '../pi/rpcTypes';
import { errorMessage } from '../utils/errorMessage';
import type { CrustLogLevel } from '../utils/crustLogger';

const execFileAsync = promisify(execFile);

type LogFn = (message: string, details?: unknown, level?: CrustLogLevel) => void;

const supportedBuiltinSlashCommandNames = new Set(['new', 'compact', 'name', 'resume', 'model', 'copy', 'quit', 'changelog', 'reload']);

export function isSupportedBuiltinSlashCommand(commandName: string): boolean {
	return supportedBuiltinSlashCommandNames.has(commandName);
}

export function markUnsupportedBuiltinSlashCommands(commands: SlashCommand[]): SlashCommand[] {
	return commands.map((command) => markUnsupportedBuiltinSlashCommand(command));
}

export function orderSlashCommands(builtinCommands: SlashCommand[], piCommands: SlashCommand[]): SlashCommand[] {
	const supportedBuiltinCommands = builtinCommands.filter((command) => command.source !== 'builtin' || isSupportedBuiltinSlashCommand(command.name));
	const unsupportedBuiltinCommands = builtinCommands
		.filter((command) => command.source === 'builtin' && !isSupportedBuiltinSlashCommand(command.name))
		.map((command) => markUnsupportedBuiltinSlashCommand(command));
	return dedupeSlashCommands([
		...supportedBuiltinCommands,
		...piCommands,
		...unsupportedBuiltinCommands,
	]);
}

function markUnsupportedBuiltinSlashCommand(command: SlashCommand): SlashCommand {
	if (command.source !== 'builtin' || isSupportedBuiltinSlashCommand(command.name)) {
		return command;
	}
	return { ...command, description: 'not supported yet', disabled: true };
}

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
		const piCliPath = await getPiCliPath();
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

export async function getPiChangelogMarkdown(log: LogFn): Promise<string> {
	try {
		const piCliPath = await getPiCliPath();
		const changelogPath = resolve(dirname(piCliPath), '..', 'CHANGELOG.md');
		const content = await readFile(changelogPath, 'utf8');
		const entries = parseChangelogEntries(content);
		return entries.length ? entries.reverse().join('\n\n') : 'No changelog entries found.';
	} catch (error) {
		log('Failed to load Pi changelog', { error: errorMessage(error) }, 'warn');
		return 'No changelog entries found.';
	}
}

function parseChangelogEntries(content: string): string[] {
	const entries: string[] = [];
	let currentLines: string[] = [];
	let hasCurrentVersion = false;
	for (const line of content.split('\n')) {
		if (line.startsWith('## ')) {
			if (hasCurrentVersion && currentLines.length) {
				entries.push(currentLines.join('\n').trim());
			}
			hasCurrentVersion = /##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/.test(line);
			currentLines = hasCurrentVersion ? [line] : [];
		} else if (hasCurrentVersion) {
			currentLines.push(line);
		}
	}
	if (hasCurrentVersion && currentLines.length) {
		entries.push(currentLines.join('\n').trim());
	}
	return entries;
}

async function getPiCliPath(): Promise<string> {
	const { stdout } = await execFileAsync('which', ['pi']);
	return realpath(stdout.trim());
}

const fallbackCommands: SlashCommand[] = [
	{ name: 'new', description: 'Start a new session', source: 'builtin' },
	{ name: 'compact', description: 'Manually compact context, optional custom instructions', source: 'builtin' },
	{ name: 'name', description: 'Set the session name', source: 'builtin' },
	{ name: 'resume', description: 'Resume a previous session', source: 'builtin' },
	{ name: 'model', description: 'Select model', source: 'builtin' },
	{ name: 'copy', description: 'Copy last agent message to clipboard', source: 'builtin' },
	{ name: 'changelog', description: 'Show changelog entries', source: 'builtin' },
	{ name: 'reload', description: 'Reload Pi resources by restarting the Pi RPC process', source: 'builtin' },
	{ name: 'quit', description: 'Close the Crust tab', source: 'builtin' },
];
