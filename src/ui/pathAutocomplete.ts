import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FsDirent, PathSuggestion, ScoredPathSuggestion } from './chatTypes';

const execFileAsync = promisify(execFile);

export async function getPathSuggestions(cwd: string | undefined, query: string): Promise<PathSuggestion[]> {
	if (!cwd) {
		return [];
	}

	const normalizedQuery = query.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
	const gitSuggestions = await getGitPathSuggestions(cwd, normalizedQuery);
	if (gitSuggestions) {
		return gitSuggestions;
	}

	const suggestions: ScoredPathSuggestion[] = [];
	await collectPathSuggestions(cwd, '', normalizedQuery, suggestions);
	return rankPathSuggestions(suggestions);
}

async function getGitPathSuggestions(cwd: string, query: string): Promise<PathSuggestion[] | undefined> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard']);
		const suggestions = new Map<string, ScoredPathSuggestion>();
		for (const filePath of stdout.split('\n').filter(Boolean)) {
			addPathSuggestion(suggestions, filePath, false, query);
			const parts = filePath.split('/');
			for (let index = 1; index < parts.length; index++) {
				addPathSuggestion(suggestions, `${parts.slice(0, index).join('/')}/`, true, query);
			}
		}
		return rankPathSuggestions([...suggestions.values()]);
	} catch {
		return undefined;
	}
}

function addPathSuggestion(
	suggestions: Map<string, ScoredPathSuggestion>,
	path: string,
	isDirectory: boolean,
	query: string,
): void {
	const score = getPathSuggestionScore(path, query);
	if (score === undefined) {
		return;
	}
	const trimmedPath = path.endsWith('/') ? path.slice(0, -1) : path;
	const name = basename(trimmedPath) || trimmedPath;
	suggestions.set(path, { path, name, isDirectory, score });
}

function rankPathSuggestions(suggestions: ScoredPathSuggestion[]): PathSuggestion[] {
	return suggestions
		.sort((a, b) => a.score - b.score || Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path))
		.slice(0, 100)
		.map(({ path, name, isDirectory }) => ({ path, name, isDirectory }));
}

async function collectPathSuggestions(
	absoluteDirectory: string,
	relativeDirectory: string,
	query: string,
	suggestions: ScoredPathSuggestion[],
): Promise<void> {
	let entries: FsDirent[];
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isFile()) {
			continue;
		}

		const relativePath = join(relativeDirectory, entry.name).split(sep).join('/');
		const displayPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
		const score = getPathSuggestionScore(displayPath, query);
		if (score !== undefined) {
			suggestions.push({ path: displayPath, name: entry.name, isDirectory: entry.isDirectory(), score });
		}

		if (entry.isDirectory()) {
			await collectPathSuggestions(join(absoluteDirectory, entry.name), relativePath, query, suggestions);
		}
	}
}

function getPathSuggestionScore(path: string, query: string): number | undefined {
	if (!query) {
		return path.length;
	}

	const lowerPath = path.toLowerCase();
	let queryIndex = 0;
	let fuzzyScore = 1000;
	for (let pathIndex = 0; pathIndex < lowerPath.length; pathIndex++) {
		if (lowerPath.startsWith(query, pathIndex)) {
			return pathIndex * 10 + path.length / 1000;
		}

		if (queryIndex < query.length && lowerPath[pathIndex] === query[queryIndex]) {
			fuzzyScore += pathIndex;
			queryIndex++;
		}
	}
	return queryIndex === query.length ? fuzzyScore + path.length / 1000 : undefined;
}
