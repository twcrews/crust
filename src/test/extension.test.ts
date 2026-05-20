import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as vscode from 'vscode';
import { PiRpcClient } from '../pi/piRpcClient';
import { isRpcEvent, isRpcResponse, isSlashCommand, isToolResult, normalizeSlashCommand } from '../pi/rpcTypes';
import { formatErrorForChat, getAssistantErrorMessage, getLastModelFromSessionText } from '../ui/chatPanelUtils';
import { createConversationState } from '../ui/conversationState';
import { buildPromptWithIdeContext, extractRestoredPrompt, formatSelectionRange, getIdeContext } from '../ui/ideContext';
import { getMessageContent, getBlockText, getBlockType, getEntryTimestamp, getMessageRole, getMessageText, getMessageTimestamp, parseJsonObject } from '../ui/messageUtils';
import { restoreSessionMessages } from '../ui/sessionRestoreRenderer';
import { getBuiltinSlashCommands, getPiChangelogMarkdown, markUnsupportedBuiltinSlashCommands, orderSlashCommands } from '../ui/slashCommands';
import { StreamingEventRenderer } from '../ui/streamingEventRenderer';
import { getPathSuggestions } from '../ui/pathAutocomplete';
import { listSessions } from '../ui/sessionHistory';
import { getChatWebviewHtml } from '../ui/chatWebview';
import { parseWebviewMessage } from '../ui/chatTypes';
import { getToolBody, getToolHeaderDetail, getToolPath, getToolResultText, isFileTool, isRenderableTool } from '../ui/toolUtils';
import { formatUsageStatus } from '../ui/usageStatus';
import { errorMessage } from '../utils/errorMessage';
import { getNonce } from '../utils/nonce';

suite('RPC type guards', () => {
	test('identifies valid responses and rejects malformed responses', () => {
		assert.strictEqual(isRpcResponse({ type: 'response', command: 'get_state', success: true }), true);
		assert.strictEqual(isRpcResponse({ type: 'response', command: 'get_state' }), false);
		assert.strictEqual(isRpcResponse({ type: 'event', command: 'get_state', success: true }), false);
		assert.strictEqual(isRpcResponse(null), false);
	});

	test('validates known RPC event shapes', () => {
		assert.strictEqual(isRpcEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }), true);
		assert.strictEqual(isRpcEvent({ type: 'model_select', model: { id: 'gpt-5', provider: 'openai' } }), true);
		assert.strictEqual(isRpcEvent({ type: 'assistant_message', assistantMessageEvent: { type: 'delta' } }), false);
		assert.strictEqual(isRpcEvent({ type: 'model_select', model: { id: 'missing provider' } }), false);
		assert.strictEqual(isRpcEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 42 } }), false);
		assert.strictEqual(isRpcEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' } }), true);
		assert.strictEqual(isRpcEvent({ type: 'message_end', message: 'not a message' }), false);
		assert.strictEqual(isRpcEvent({ type: 42 }), false);
		assert.strictEqual(isRpcEvent(undefined), false);
	});

	test('normalizes slash command sourceInfo from Pi RPC', () => {
		const command = normalizeSlashCommand({
			name: 'project:fix',
			description: 'Fix something',
			source: 'custom',
			sourceInfo: {
				path: '/repo/.pi/commands/fix.md',
				source: 'filesystem',
				scope: 'project',
				origin: 'top-level',
			},
		});

		assert.deepStrictEqual(command, {
			name: 'project:fix',
			description: 'Fix something',
			source: 'custom',
			location: 'project',
			path: '/repo/.pi/commands/fix.md',
			sourceInfo: {
				path: '/repo/.pi/commands/fix.md',
				source: 'filesystem',
				scope: 'project',
				origin: 'top-level',
			},
		});
		assert.strictEqual(normalizeSlashCommand({ name: 'bad', sourceInfo: { path: '/tmp/cmd.md' } }), undefined);
		assert.strictEqual(isSlashCommand({ name: 'bad', path: 1 }), false);
	});

	test('validates typed tool results used by tool execution events', () => {
		assert.strictEqual(isToolResult({ content: [{ type: 'text', text: 'ok' }], details: { diff: '--- a' } }), true);
		assert.strictEqual(isToolResult({ content: [{ type: 'image' }] }), true);
		assert.strictEqual(isToolResult({ content: [{ type: 'text', text: 42 }] }), false);
		assert.strictEqual(isToolResult({ content: 'plain text' }), false);
		assert.strictEqual(isToolResult({ details: 'not an object' }), false);

		assert.strictEqual(isRpcEvent({ type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'partial' }] } }), true);
		assert.strictEqual(isRpcEvent({ type: 'tool_execution_update', partialResult: { content: 'bad' } }), false);
		assert.strictEqual(isRpcEvent({ type: 'tool_execution_end', result: { details: { stdout: 'done' } }, isError: false }), true);
		assert.strictEqual(isRpcEvent({ type: 'tool_execution_end', result: { details: 1 } }), false);
	});
});

suite('Pi RPC client', () => {
	test('sends steer and abort RPC commands', async () => {
		type TestableClient = {
			start: () => Promise<void>;
			process?: { stdin: { write: (payload: string, callback: (error?: Error) => void) => void } };
			handleStdout: (chunk: string) => void;
		};

		const client = new PiRpcClient(undefined);
		const testable = client as unknown as TestableClient;
		const sentTypes: string[] = [];

		testable.start = async () => {
			testable.process = {
				stdin: {
					write: (payload, callback) => {
						const command = JSON.parse(payload) as { id: string; type: string };
						sentTypes.push(command.type);
						callback();
						testable.handleStdout(`${JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true })}\n`);
					},
				},
			};
		};

		await client.steer('adjust course');
		await client.abort();

		assert.deepStrictEqual(sentTypes, ['steer', 'abort']);
	});

	test('returns compact response data from Pi RPC', async () => {
		type TestableClient = {
			start: () => Promise<void>;
			process?: { stdin: { write: (payload: string, callback: (error?: Error) => void) => void } };
			handleStdout: (chunk: string) => void;
		};

		const client = new PiRpcClient(undefined);
		const testable = client as unknown as TestableClient;
		const sent: unknown[] = [];
		testable.start = async () => {
			testable.process = {
				stdin: {
					write: (payload, callback) => {
						const command = JSON.parse(payload) as { id: string; type: string; customInstructions?: string };
						sent.push(command);
						callback();
						testable.handleStdout(`${JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { summary: 'Kept important context', tokensBefore: 12345 } })}\n`);
					},
				},
			};
		};

		const result = await client.compact('focus on tests');

		assert.deepStrictEqual(result, { summary: 'Kept important context', tokensBefore: 12345 });
		assert.deepStrictEqual(sent, [{ id: (sent[0] as { id: string }).id, type: 'compact', customInstructions: 'focus on tests' }]);
	});

	test('returns clone cancellation state from Pi RPC', async () => {
		type TestableClient = {
			start: () => Promise<void>;
			process?: { stdin: { write: (payload: string, callback: (error?: Error) => void) => void } };
			handleStdout: (chunk: string) => void;
		};

		const client = new PiRpcClient(undefined);
		const testable = client as unknown as TestableClient;
		const sentTypes: string[] = [];
		testable.start = async () => {
			testable.process = {
				stdin: {
					write: (payload, callback) => {
						const command = JSON.parse(payload) as { id: string; type: string };
						sentTypes.push(command.type);
						callback();
						testable.handleStdout(`${JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { cancelled: true } })}\n`);
					},
				},
			};
		};

		assert.strictEqual(await client.clone(), false);
		assert.deepStrictEqual(sentTypes, ['clone']);
	});

	test('returns exported HTML path from Pi RPC', async () => {
		type TestableClient = {
			start: () => Promise<void>;
			process?: { stdin: { write: (payload: string, callback: (error?: Error) => void) => void } };
			handleStdout: (chunk: string) => void;
		};

		const client = new PiRpcClient(undefined);
		const testable = client as unknown as TestableClient;
		const sent: unknown[] = [];
		testable.start = async () => {
			testable.process = {
				stdin: {
					write: (payload, callback) => {
						const command = JSON.parse(payload) as { id: string; type: string; outputPath?: string };
						sent.push(command);
						callback();
						testable.handleStdout(`${JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { path: '/tmp/session.html' } })}\n`);
					},
				},
			};
		};

		assert.strictEqual(await client.exportHtml('/tmp/session.html'), '/tmp/session.html');
		assert.deepStrictEqual(sent, [{ id: (sent[0] as { id: string }).id, type: 'export_html', outputPath: '/tmp/session.html' }]);
	});
});

suite('Slash commands', () => {
	test('falls back to built-in commands when Pi slash metadata cannot be loaded', async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = '';
		try {
			const commands = await getBuiltinSlashCommands(() => undefined);
			assert.deepStrictEqual(commands.map((command) => command.name), ['new', 'compact', 'clone', 'export', 'name', 'session', 'resume', 'model', 'copy', 'changelog', 'reload', 'quit']);
			assert.ok(commands.every((command) => command.source === 'builtin'));
		} finally {
			process.env.PATH = originalPath;
		}
	});

	test('marks unsupported built-in slash commands disabled and orders them last', () => {
		const commands = markUnsupportedBuiltinSlashCommands([
			{ name: 'compact', description: 'Compact context', source: 'builtin' },
			{ name: 'clone', description: 'Clone session', source: 'builtin' },
			{ name: 'help', description: 'Show help', source: 'builtin' },
			{ name: 'project:fix', description: 'Fix', source: 'custom' },
		]);

		assert.deepStrictEqual(commands, [
			{ name: 'compact', description: 'Compact context', source: 'builtin' },
			{ name: 'clone', description: 'Clone session', source: 'builtin' },
			{ name: 'help', description: 'not supported yet', source: 'builtin', disabled: true },
			{ name: 'project:fix', description: 'Fix', source: 'custom' },
		]);

		assert.deepStrictEqual(orderSlashCommands([
			{ name: 'new', source: 'builtin' },
			{ name: 'clone', source: 'builtin' },
			{ name: 'export', source: 'builtin' },
			{ name: 'copy', source: 'builtin' },
			{ name: 'session', source: 'builtin' },
			{ name: 'changelog', source: 'builtin' },
			{ name: 'reload', source: 'builtin' },
			{ name: 'help', description: 'Show help', source: 'builtin' },
			{ name: 'doctor', description: 'Diagnose', source: 'builtin' },
		], [
			{ name: 'skill:fix', source: 'custom' },
			{ name: 'project:review', source: 'custom' },
		]).map((command) => command.name), ['new', 'clone', 'export', 'copy', 'session', 'changelog', 'reload', 'skill:fix', 'project:review', 'help', 'doctor']);
	});

	test('returns fallback text when Pi changelog cannot be loaded', async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = '';
		try {
			assert.strictEqual(await getPiChangelogMarkdown(() => undefined), 'No changelog entries found.');
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

suite('Webview message parsing', () => {
	test('accepts known webview messages and normalizes optional fields', () => {
		assert.deepStrictEqual(parseWebviewMessage({ type: 'submit', text: 'hello' }), { type: 'submit', text: 'hello', includeIdeContext: false });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'submit', text: 'hello', includeIdeContext: true }), { type: 'submit', text: 'hello', includeIdeContext: true });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'selectModel' }), { type: 'selectModel', modelKey: undefined });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'openProjectFile', path: 'src/ui/chatPanel.ts:12' }), { type: 'openProjectFile', path: 'src/ui/chatPanel.ts:12' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'validateFileReferences', requestId: 1, references: ['src/ui/chatPanel.ts', 2] }), { type: 'validateFileReferences', requestId: 1, references: ['src/ui/chatPanel.ts'] });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'webviewLog', message: 'loaded', details: { ok: true }, level: 'debug' }), { type: 'webviewLog', message: 'loaded', details: { ok: true }, level: 'info' });
		assert.deepStrictEqual(parseWebviewMessage({ type: 'webviewLog', message: 'failed', level: 'error' }), { type: 'webviewLog', message: 'failed', details: undefined, level: 'error' });
	});

	test('rejects malformed or unknown webview messages', () => {
		assert.strictEqual(parseWebviewMessage(undefined), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'submit' }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'steer', text: 1 }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'selectModel', modelKey: 1 }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'pathAutocomplete', requestId: '1', query: 'src' }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'openProjectFile', path: 1 }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'validateFileReferences', requestId: '1', references: [] }), undefined);
		assert.strictEqual(parseWebviewMessage({ type: 'unknown' }), undefined);
	});
});

suite('Message utilities', () => {
	test('safely reads message and block fields', () => {
		const message = { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'hmm' }], timestamp: 123 };
		assert.deepStrictEqual(getMessageContent(message), message.content);
		assert.strictEqual(getMessageRole(message), 'assistant');
		assert.strictEqual(getMessageTimestamp(message), 123);
		assert.strictEqual(getBlockType(message.content[0]), 'text');
		assert.strictEqual(getBlockText(message.content[0], 'text'), 'hello');
		assert.strictEqual(getBlockText(message.content[1], 'thinking'), 'hmm');
	});

	test('extracts text from string and text block content only', () => {
		assert.strictEqual(getMessageText({ content: 'plain text' }), 'plain text');
		assert.strictEqual(getMessageText({ content: [{ type: 'text', text: 'one' }, { type: 'tool_use', text: 'skip' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
		assert.strictEqual(getMessageText({ content: [{ type: 'text' }] }), '');
		assert.strictEqual(getMessageText('not a message'), '');
	});

	test('parses JSON object lines and timestamps defensively', () => {
		assert.deepStrictEqual(parseJsonObject('{"type":"message"}'), { type: 'message' });
		assert.strictEqual(parseJsonObject('[]'), undefined);
		assert.strictEqual(parseJsonObject('not-json'), undefined);
		assert.strictEqual(getEntryTimestamp({ timestamp: '2024-01-02T03:04:05.000Z' }), Date.UTC(2024, 0, 2, 3, 4, 5));
		assert.strictEqual(getEntryTimestamp({ timestamp: 'invalid' }), undefined);
	});
});

suite('Chat panel helpers', () => {
	test('pretty-prints JSON provider errors for chat', () => {
		assert.strictEqual(formatErrorForChat('plain failure'), 'Error: plain failure');
		assert.strictEqual(formatErrorForChat('provider failed {"error":{"message":"quota","code":429}}'), [
			'Error: provider failed',
			'',
			'```json',
			'{',
			'  "error": {',
			'    "message": "quota",',
			'    "code": 429',
			'  }',
			'}',
			'```',
		].join('\n'));
	});

	test('detects explicit assistant errors without scanning arbitrary text', () => {
		assert.strictEqual(getAssistantErrorMessage({ role: 'assistant', content: 'Error: harmless text' }), undefined);
		assert.strictEqual(getAssistantErrorMessage({ role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' }), 'provider failed');
		assert.strictEqual(getAssistantErrorMessage({ role: 'assistant', stopReason: 'error' }), 'Unknown error');
		assert.strictEqual(getAssistantErrorMessage({ role: 'user', stopReason: 'error', errorMessage: 'ignore' }), undefined);
	});

	test('reads the latest model from model changes and assistant session messages', () => {
		const knownModel = { provider: 'anthropic', id: 'claude-4', name: 'Claude 4' };
		const sessionText = [
			JSON.stringify({ type: 'model_change', provider: 'openai', modelId: 'gpt-5' }),
			JSON.stringify({ type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'claude-4', content: 'hello' } }),
		].join('\n');

		assert.deepStrictEqual(getLastModelFromSessionText(sessionText, [knownModel]), knownModel);
		assert.deepStrictEqual(getLastModelFromSessionText('{"type":"model_change","provider":"x","modelId":"y"}', []), { provider: 'x', id: 'y' });
	});
});

suite('Streaming event renderer', () => {
	function createRenderer() {
		const state = createConversationState();
		const posts: unknown[] = [];
		const processing: boolean[] = [];
		const finalizedUsage: unknown[] = [];
		const callbacks = {
			post: (message: unknown) => posts.push(message),
			setProcessing: (isProcessing: boolean) => processing.push(isProcessing),
			setCurrentModel: () => undefined,
			finalizeUsageStatus: (message: unknown) => finalizedUsage.push(message),
			postCurrentUsageStatus: () => posts.push({ type: 'usage' }),
			postCurrentSessionPath: () => posts.push({ type: 'sessionPath' }),
			refreshCurrentModel: () => posts.push({ type: 'refreshModel' }),
		};
		return { state, posts, processing, finalizedUsage, renderer: new StreamingEventRenderer(state, callbacks) };
	}

	test('renders provider failures from message_end events', () => {
		const { renderer, posts, finalizedUsage } = createRenderer();
		const message = { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed {"status":500}' };

		renderer.handlePiEvent({ type: 'message_end', message });

		assert.deepStrictEqual(posts[0], { type: 'addMessage', id: (posts[0] as { id: string }).id, role: 'assistant', text: '' });
		assert.deepStrictEqual(posts[1], { type: 'appendMessage', id: (posts[0] as { id: string }).id, text: '\nError: provider failed\n\n```json\n{\n  "status": 500\n}\n```', error: true });
		assert.deepStrictEqual(finalizedUsage, [message]);
	});

	test('does not duplicate assistant errors across update and end events', () => {
		const { renderer, posts } = createRenderer();
		const message = { role: 'assistant', stopReason: 'error', errorMessage: 'first failure' };

		renderer.handlePiEvent({ type: 'message_update', message, assistantMessageEvent: { type: 'error', reason: 'fallback', contentIndex: 0 } });
		renderer.handlePiEvent({ type: 'agent_end', message });

		assert.strictEqual(posts.filter((post) => (post as { type?: string }).type === 'appendMessage').length, 1);
		assert.ok(posts.some((post) => (post as { type?: string }).type === 'sessionPath'));
		assert.ok(posts.some((post) => (post as { type?: string }).type === 'refreshModel'));
	});

	test('streams text after tool use as a new chronological message segment', () => {
		const { renderer, posts } = createRenderer();

		renderer.handlePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Before tool.', contentIndex: 0 } });
		renderer.handlePiEvent({
			type: 'message_update',
			assistantMessageEvent: {
				type: 'toolcall_end',
				contentIndex: 1,
				toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'echo hi' } },
			},
		});
		renderer.handlePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'After tool.', contentIndex: 0 } });

		const addMessages = posts.filter((post) => (post as { type?: string }).type === 'addMessage');
		const appendMessages = posts.filter((post) => (post as { type?: string }).type === 'appendMessage');
		const toolIndex = posts.findIndex((post) => (post as { type?: string }).type === 'upsertTool');
		const secondAddIndex = posts.findIndex((post) => (post as { type?: string; id?: string }).type === 'addMessage' && (post as { id?: string }).id === (appendMessages[1] as { id?: string }).id);

		assert.strictEqual(addMessages.length, 2);
		assert.notStrictEqual((appendMessages[0] as { id?: string }).id, (appendMessages[1] as { id?: string }).id);
		assert.ok(toolIndex >= 0);
		assert.ok(secondAddIndex > toolIndex);
	});

	test('renders abort indicators and clears streaming state on agent end', () => {
		const { renderer, state, posts, processing } = createRenderer();
		state.activeToolCallIds.set('id:old', 'tool-old');

		renderer.handlePiEvent({ type: 'agent_start' });
		renderer.handlePiEvent({ type: 'agent_end', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Stopped by user' } });

		assert.deepStrictEqual(processing, [true, false]);
		assert.strictEqual(state.isStreaming, false);
		assert.strictEqual(state.activeToolCallIds.size, 0);
		assert.ok(posts.some((post) => (post as { text?: string; secondary?: boolean }).text === '_Stopped by user_' && (post as { secondary?: boolean }).secondary));
	});
});

suite('Session restore rendering', () => {
	test('restores text, thinking, tool calls, results, slash labels, and aborts', () => {
		const posts: unknown[] = [];
		const result = restoreSessionMessages([
			{ role: 'user', content: '/compact' },
			{ role: 'assistant', content: [
				{ type: 'thinking', thinking: 'considering' },
				{ type: 'text', text: 'Answer' },
				{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'old', newText: 'new' }] } },
			] },
			{ role: 'toolResult', toolCallId: 'call-1', toolName: 'edit', details: { diff: '--- a\n+++ b' } },
			{ role: 'assistant', stopReason: 'aborted', errorMessage: 'Interrupted', content: '' },
			{ role: 'compactionSummary', summary: 'Short summary\n\n---\n\nFull details', tokensBefore: 12000 },
		], undefined, (message) => posts.push(message), (text) => text === '/compact' ? '/compact' : undefined);

		assert.deepStrictEqual(result, { title: '/compact', hasSessionTitle: true });
		assert.ok(posts.some((post) => (post as { slashCommandLabel?: string }).slashCommandLabel === '/compact'));
		assert.ok(posts.some((post) => (post as { type?: string }).type === 'addThinking'));
		assert.ok(posts.some((post) => (post as { type?: string; text?: string }).type === 'addMessage' && (post as { text?: string }).text === 'Answer'));
		assert.ok(posts.some((post) => (post as { type?: string; status?: string; isDiff?: boolean }).type === 'upsertTool' && (post as { status?: string }).status === 'done' && (post as { isDiff?: boolean }).isDiff));
		assert.ok(posts.some((post) => (post as { text?: string; secondary?: boolean }).text === '_Interrupted_' && (post as { secondary?: boolean }).secondary));
		assert.ok(posts.some((post) => (post as { compaction?: boolean; text?: string }).compaction === true && (post as { text?: string }).text?.includes('12k tokens summarized')));
	});
});

suite('IDE context utilities', () => {
	test('formats selections using VS Code one-based line numbers', () => {
		assert.strictEqual(formatSelectionRange(new vscode.Selection(0, 0, 0, 5)), '1');
		assert.strictEqual(formatSelectionRange(new vscode.Selection(0, 0, 2, 3)), '1-3');
		assert.strictEqual(formatSelectionRange(new vscode.Selection(0, 0, 2, 0)), '1-2');
	});

	test('builds and strips prompt wrappers with selected text metadata', () => {
		const prompt = buildPromptWithIdeContext('Fix this', {
			label: 'example.ts:2-3',
			filePath: 'src/example.ts',
			languageId: 'typescript',
			selectionRange: '2-3',
			selectedText: 'const x = 1;',
		});

		assert.ok(prompt.startsWith('<ide_context>\nCurrent file: src/example.ts\nSelected lines: 2-3'));
		assert.ok(prompt.includes('```typescript\nconst x = 1;\n```'));
		assert.strictEqual(prompt.endsWith('\n\nFix this'), true);
		assert.deepStrictEqual(extractRestoredPrompt(prompt), { text: 'Fix this', ideContextLabel: 'example.ts:2-3', skillLabel: undefined });
		assert.deepStrictEqual(extractRestoredPrompt('No wrapper'), { text: 'No wrapper', ideContextLabel: undefined, skillLabel: undefined });
	});

	test('strips restored skill wrappers and preserves user text', () => {
		const skillPrompt = [
			'<skill name="review" location="/repo/.pi/skills/review.md">',
			'Skill instructions',
			'</skill>',
			'',
			'User: Review this file',
		].join('\n');

		assert.deepStrictEqual(extractRestoredPrompt(skillPrompt), { text: 'Review this file', ideContextLabel: undefined, skillLabel: '/skill:review' });
		assert.deepStrictEqual(extractRestoredPrompt(skillPrompt.replace('\n\nUser: Review this file', '')), { text: '', ideContextLabel: undefined, skillLabel: '/skill:review' });
	});

	test('strips IDE context before restored skill wrappers', () => {
		const prompt = `${buildPromptWithIdeContext('', { label: 'example.ts', filePath: 'src/example.ts', languageId: 'typescript' }).trim()}\n<skill name="fix" location="/repo/.pi/skills/fix.md">\nSkill instructions\n</skill>\n\nUser: Fix this`;

		assert.deepStrictEqual(extractRestoredPrompt(prompt), { text: 'Fix this', ideContextLabel: 'example.ts', skillLabel: '/skill:fix' });
	});

	test('gets file and selection context from an editor', async () => {
		const document = await vscode.workspace.openTextDocument({ content: 'alpha\nbeta\ngamma\n', language: 'plaintext' });
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(1, 0, 2, 0);

		const context = getIdeContext(editor);
		assert.strictEqual(context?.label, `${document.fileName}:2`);
		assert.strictEqual(context?.filePath, document.fileName);
		assert.strictEqual(context?.languageId, 'plaintext');
		assert.strictEqual(context?.selectionRange, '2');
		assert.strictEqual(context?.selectedText, 'beta\n');
	});
});

suite('Tool utilities', () => {
	test('recognizes file tools and extracts paths from args', () => {
		assert.strictEqual(isFileTool('read'), true);
		assert.strictEqual(isFileTool('write'), true);
		assert.strictEqual(isFileTool('edit'), true);
		assert.strictEqual(isFileTool('bash'), false);
		assert.strictEqual(isRenderableTool('bash'), true);
		assert.strictEqual(getToolPath({ path: 'src/a.ts' }), 'src/a.ts');
		assert.strictEqual(getToolPath({ file_path: 'src/b.ts' }), 'src/b.ts');
		assert.strictEqual(getToolPath({ path: 1 }), undefined);
		assert.strictEqual(getToolHeaderDetail('read', { path: 'src/a.ts' }), 'src/a.ts');
		assert.strictEqual(getToolHeaderDetail('read', { path: 'src/a.ts', offset: 8, limit: 1 }), 'src/a.ts line 8');
		assert.strictEqual(getToolHeaderDetail('read', { path: 'src/a.ts', offset: 55, limit: 17 }), 'src/a.ts lines 55-71');
		assert.strictEqual(getToolHeaderDetail('read', { path: 'src/a.ts', limit: 10 }), 'src/a.ts lines 1-10');
		assert.strictEqual(getToolHeaderDetail('read', { path: 'src/a.ts', limit: 10 }, { content: [{ type: 'text', text: 'entire file' }] }), 'src/a.ts');
		assert.strictEqual(getToolHeaderDetail('read', { path: 'src/a.ts', limit: 10 }, { content: [{ type: 'text', text: 'partial\n\n[5 more lines in file. Use offset=11 to continue.]' }] }), 'src/a.ts lines 1-10');
		assert.strictEqual(getToolHeaderDetail('bash', { command: 'npm test' }), 'npm test');
		assert.strictEqual(getToolHeaderDetail('bash', { cmd: 'pnpm test' }), 'pnpm test');
	});

	test('builds previews for write and edit tools', () => {
		assert.strictEqual(getToolBody('read', { path: 'src/a.ts' }), undefined);
		assert.strictEqual(getToolBody('write', { content: 'new content' }), 'new content');
		assert.strictEqual(getToolBody('edit', { edits: [{ oldText: 'old\ntext', newText: 'new' }] }), '@@ edit 1 @@\n-old\n-text\n+new');
		assert.strictEqual(getToolBody('bash', { command: 'npm test' }), '$ npm test');
		assert.strictEqual(getToolBody('bash', { cmd: 'pnpm test' }), '$ pnpm test');
		assert.strictEqual(getToolBody('edit', { edits: 'invalid' }), undefined);
	});

	test('extracts text-only tool result content', () => {
		assert.strictEqual(getToolResultText({ content: [{ type: 'text', text: ' first ' }, { type: 'image', text: 'skip' }, { type: 'text', text: 'second' }] }), 'first \nsecond');
		assert.strictEqual(getToolResultText({ content: [{ type: 'image', text: 'skip' }] }), undefined);
		assert.strictEqual(getToolResultText({ details: { stdout: 'out', stderr: 'err' } }), 'out\nerr');
		assert.strictEqual(getToolResultText({ details: { output: 'out', stdout: 'ignored?' } }), 'out\nignored?');
		assert.strictEqual(getToolResultText(undefined), undefined);
	});
});

suite('Usage status formatting', () => {
	test('sums nested usage fields and formats context/cost', () => {
		const status = formatUsageStatus([
			{ usage: { input: 1000, output: 250, cacheRead: 50, cacheWrite: 25, totalTokens: 1325, cost: { total: 0.01 } } },
			{ message: { usage: { input: 200, output: 300, totalTokens: 500, cost: { total: 0.02 } } } },
			{ usage: { input: Number.NaN, output: 'bad', cost: { total: Number.NaN } } },
		], 2000);

		assert.strictEqual(status, '1.8k · 1.2k in · 550 out · 25%/2k · $0.03');
	});

	test('falls back to component token totals when totalTokens is absent', () => {
		assert.strictEqual(formatUsageStatus([{ usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 } }], undefined), '20 · 10 in · 5 out · $0.00');
	});
});

suite('Path autocomplete', () => {
	let directory: string;

	setup(async () => {
		directory = await mkdtemp(join(tmpdir(), 'crust-paths-'));
		await mkdir(join(directory, 'src', 'nested'), { recursive: true });
		await mkdir(join(directory, 'docs'), { recursive: true });
		await writeFile(join(directory, 'src', 'chatPanel.ts'), '');
		await writeFile(join(directory, 'src', 'nested', 'usageStatus.ts'), '');
		await writeFile(join(directory, 'docs', 'README.md'), '');
	});

	teardown(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test('returns ranked filesystem suggestions without a cwd or git repository', async () => {
		assert.deepStrictEqual(await getPathSuggestions(undefined, 'src'), []);

		const suggestions = await getPathSuggestions(directory, 'src');
		assert.ok(suggestions.some((suggestion) => suggestion.path === 'src/' && suggestion.isDirectory));
		assert.ok(suggestions.some((suggestion) => suggestion.path === 'src/chatPanel.ts' && !suggestion.isDirectory));
	});

	test('normalizes slash-prefixed and backslash queries and supports fuzzy matches', async () => {
		const normalized = await getPathSuggestions(directory, '/src\\chat');
		assert.strictEqual(normalized[0]?.path, 'src/chatPanel.ts');

		const fuzzy = await getPathSuggestions(directory, 'usts');
		assert.ok(fuzzy.some((suggestion) => suggestion.path === 'src/nested/usageStatus.ts'));
	});
});

suite('Session history', () => {
	let cwd: string;
	let sessionRoot: string;
	let previousSessionDir: string | undefined;

	setup(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'crust-workspace-'));
		sessionRoot = await mkdtemp(join(tmpdir(), 'crust-sessions-'));
		previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = sessionRoot;
	});

	teardown(async () => {
		if (previousSessionDir === undefined) {
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		} else {
			process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		}
		await rm(cwd, { recursive: true, force: true });
		await rm(sessionRoot, { recursive: true, force: true });
	});

	test('lists Pi JSONL sessions sorted by message timestamp', async () => {
		const directory = join(sessionRoot, `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, 'not-a-session.jsonl'), '{"type":"message"}\n');
		await writeFile(join(directory, 'ignored.txt'), '');
		await writeFile(join(directory, 'older.jsonl'), [
			JSON.stringify({ type: 'session' }),
			JSON.stringify({ type: 'message', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'Older question' } }),
		].join('\n'));
		await writeFile(join(directory, 'newer.jsonl'), [
			JSON.stringify({ type: 'session' }),
			JSON.stringify({ type: 'session_info', name: 'Named session' }),
			JSON.stringify({ type: 'message', message: { role: 'user', content: buildPromptWithIdeContext('Newer question', { label: 'a.ts', filePath: 'src/a.ts', languageId: 'typescript' }), timestamp: Date.UTC(2024, 0, 3) } }),
			JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], timestamp: Date.UTC(2024, 0, 4) } }),
		].join('\n'));

		const sessions = await listSessions({ getState: async () => ({}) } as never, cwd);
		assert.strictEqual(sessions.length, 2);
		assert.strictEqual(sessions[0].name, 'Named session');
		assert.strictEqual(sessions[0].firstMessage, 'Newer question');
		assert.strictEqual(sessions[0].messageCount, 2);
		assert.ok(sessions[0].path.endsWith('newer.jsonl'));
		assert.strictEqual(sessions[1].firstMessage, 'Older question');
	});

	test('uses sessionFile from Pi state when available', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'crust-state-sessions-'));
		try {
			await writeFile(join(directory, 'state.jsonl'), [
				JSON.stringify({ type: 'session' }),
				JSON.stringify({ type: 'message', message: { role: 'user', content: 'From state' } }),
			].join('\n'));

			const sessions = await listSessions({ getState: async () => ({ sessionFile: join(directory, 'current.jsonl') }) } as never, undefined);
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].firstMessage, 'From state');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

suite('Webview HTML and nonce generation', () => {
	test('ranks slash command autocomplete fuzzily and formats sourceInfo metadata', async () => {
		const source = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.autocomplete.js'), 'utf8');
		const statusMessages: Array<{ message: string; error: boolean }> = [];
		const api = runInNewContext(`${source}\n({ getSlashCommandSuggestions, formatSlashCommandSource, runSlashCommand });`, {
			prompt: { value: '' },
			slashCommands: [
				{ name: 'compact', command: '/compact' },
				{ name: 'project:fix', command: '/project:fix' },
				{ name: 'resume', command: '/resume' },
				{ name: 'help', command: '/help', description: 'not supported yet', disabled: true },
			],
			setStatus: (message: string, error: boolean) => statusMessages.push({ message, error }),
		}) as {
			getSlashCommandSuggestions: (value: string) => Array<{ command: string; description?: string; disabled?: boolean }>;
			formatSlashCommandSource: (command: unknown) => string;
			runSlashCommand: (text: string) => boolean;
		};

		assert.deepStrictEqual(api.getSlashCommandSuggestions('/fx').map((suggestion) => suggestion.command), ['/project:fix']);
		assert.deepStrictEqual(api.getSlashCommandSuggestions('/co').map((suggestion) => suggestion.command).slice(0, 1), ['/compact']);
		assert.strictEqual(api.formatSlashCommandSource({ source: 'custom', sourceInfo: { scope: 'project', path: '/repo/.pi/commands/fix.md' } }), 'custom · project · /repo/.pi/commands/fix.md');
		assert.deepStrictEqual(api.getSlashCommandSuggestions('/').map((suggestion) => suggestion.command).slice(-1), ['/help']);
		assert.deepStrictEqual(api.getSlashCommandSuggestions('/he').map(({ command, description, disabled }) => ({ command, description, disabled })), [
			{ command: '/help', description: 'not supported yet', disabled: true },
		]);
		assert.match(source, /event\.key === "Enter"[\s\S]*autocompleteMode === "path"/);
		assert.strictEqual(api.runSlashCommand('/help'), true);
		assert.deepStrictEqual(statusMessages.at(-1), { message: '/help is not supported yet', error: true });
	});

	test('renders user messages with context labels and markdown bodies', async () => {
		const source = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.rendering.js'), 'utf8');

		assert.match(source, /function renderUserMessage\(element, text, ideContextLabel, slashCommandLabel\)[\s\S]*appendMessageContext\(element, ideContextLabel, ideContextLabel, createEyeIcon\(\)\);/);
		assert.match(source, /slashCommandLabel\.startsWith\("\/skill:"\) \? "Skill: " \+ slashCommandLabel\.slice\(7\) : "Slash command: " \+ slashCommandLabel/);
		assert.match(source, /if \(text\) \{[\s\S]*setMarkdownContent\(body, text\);[\s\S]*\}/);
		assert.match(source, /element\.classList\.contains\("user"\)[\s\S]*setMarkdownContent\(body, \(body\.dataset\.markdown \?\? ""\) \+ text\);[\s\S]*initUserMessageToggle\(element\);/);
	});

	test('renders compaction messages as expandable shaded bubbles with first-line previews', async () => {
		const source = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.rendering.js'), 'utf8');
		const css = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.messages.css'), 'utf8');
		const mainSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.main.js'), 'utf8');

		assert.match(mainSource, /addMessage\(message\.id[\s\S]*message\.compaction === true\);/);
		assert.match(source, /function renderCompactionMessage\(element, text\)[\s\S]*setMarkdownContent\(body, previewText \|\| fullText\);[\s\S]*Show full compaction/);
		assert.match(source, /function getCompactionPreviewText\(markdown\) \{\s*return markdown\.replace\(\/\\r\\n\/g, "\\n"\)\.split\("\\n", 1\)\[0\]\.trim\(\);\s*\}/);
		assert.match(css, /\.message\.compaction-message \{[\s\S]*border-radius: 10px;[\s\S]*background: var\(--vscode-editor-inactiveSelectionBackground\);/);
		assert.match(css, /\.compaction-toggle \{/);
	});

	test('renders tool headers with a dedicated tool name element and title text', async () => {
		const source = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.rendering.js'), 'utf8');

		assert.match(source, /function upsertTool[\s\S]*toolName\.className = "tool-name";/);
		assert.match(source, /header\.append\(toolName\);/);
		assert.match(source, /appendProjectFileLinkedText\(header, path \+ formatToolStatus\(message\.status\)\);/);
		assert.match(source, /header\.title = headerText;/);
	});

	test('validates extension messages and forwards webview log levels', async () => {
		const mainSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.main.js'), 'utf8');
		const loggingSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.logging.js'), 'utf8');

		assert.match(mainSource, /function parseExtensionMessage\(value\) \{[\s\S]*typeof value\.type !== "string"[\s\S]*return null;/);
		assert.match(mainSource, /case "markdownSettings":[\s\S]*allowRawHtml: value\.allowRawHtml === true/);
		assert.match(mainSource, /case "chatSettings":[\s\S]*includeIdeContextByDefault: value\.includeIdeContextByDefault === true/);
		assert.match(mainSource, /const message = parseExtensionMessage\(event\.data\);[\s\S]*Ignored invalid extension message[\s\S]*"warn"/);
		assert.match(loggingSource, /function logWebview\(message, details, level = "info"\)/);
		assert.match(loggingSource, /const consoleMethod = level === "error" \? console\.error : console\.warn;/);
		assert.match(loggingSource, /vscode\.postMessage\(\{ type: "webviewLog", message, details, level \}\);/);
	});

	test('wires processing state to steering and cancellation controls', async () => {
		const html = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview.html'), 'utf8');
		const source = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.main.js'), 'utf8');
		const renderingSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.rendering.js'), 'utf8');

		assert.match(html, /<button id="submit" type="submit"/);
		assert.match(html, /<svg class="stop-icon"/);
		assert.match(source, /vscode\.postMessage\(\{ type: "steer", text \}\);/);
		assert.match(source, /vscode\.postMessage\(\{ type: "cancel" \}\);/);
		assert.match(source, /document\.addEventListener\("keydown", \(event\) => \{[\s\S]*event\.key\.toLowerCase\(\) !== "c"[\s\S]*!event\.ctrlKey[\s\S]*!piProcessing[\s\S]*hasCopyableSelection\(\)[\s\S]*requestCancelCurrentTask\("keyboard"\);/);
		assert.match(source, /function hasCopyableSelection\(\) \{[\s\S]*prompt\.selectionStart !== prompt\.selectionEnd[\s\S]*window\.getSelection\(\);[\s\S]*!selection\.isCollapsed/);
		assert.match(source, /case "processing":\s*setProcessing\(message\.processing\);\s*break;/);
		assert.match(renderingSource, /secondary \? " secondary" : ""/);
	});

	test('supports terminal-style prompt history recall at textarea edges', async () => {
		const mainSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.main.js'), 'utf8');
		const stateSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.state.js'), 'utf8');

		assert.match(stateSource, /let promptHistory = Array\.isArray\(persistedWebviewState\.promptHistory\)/);
		assert.match(mainSource, /recordPromptHistory\(text\);[\s\S]*if \(!piProcessing && runSlashCommand\(text\)\)/);
		assert.match(mainSource, /if \(handleSlashAutocompleteKeydown\(event\)\) \{[\s\S]*return;[\s\S]*\}[\s\S]*if \(handlePromptHistoryKeydown\(event\)\)/);
		assert.match(mainSource, /if \(event\.key === "ArrowUp"\) \{[\s\S]*!isCursorBeforePromptText\(\)[\s\S]*setPromptFromHistory\(promptHistoryCursor - 1\);/);
		assert.match(mainSource, /if \(!isCursorAfterPromptText\(\) \|\| promptHistoryCursor >= promptHistory\.length\) \{[\s\S]*setPromptFromHistory\(promptHistoryCursor \+ 1\);/);
		assert.match(mainSource, /function isCursorBeforePromptText\(\) \{\s*return prompt\.selectionStart === 0 && prompt\.selectionEnd === 0;\s*\}/);
		assert.match(mainSource, /function isCursorAfterPromptText\(\) \{\s*return prompt\.selectionStart === prompt\.value\.length && prompt\.selectionEnd === prompt\.value\.length;\s*\}/);
		assert.match(mainSource, /updatePersistedWebviewState\(\{ promptHistory \}\);/);
	});

	test('contributes security-sensitive and startup settings with expected defaults', async () => {
		const packageJson = JSON.parse(await readFile(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } } };
		const properties = packageJson.contributes?.configuration?.properties;

		assert.strictEqual(properties?.['crust.markdown.allowRawHtml']?.default, false);
		assert.strictEqual(properties?.['crust.pi.commandPath']?.default, 'pi');
		assert.strictEqual(properties?.['crust.chat.includeIdeContextByDefault']?.default, false);
		assert.strictEqual(properties?.['crust.chat.lockEditorGroupOnOpen']?.default, true);
		assert.strictEqual(properties?.['crust.pi.defaultModel']?.default, '');
		assert.strictEqual(properties?.['crust.session.restoreOnReload']?.default, true);
	});

	test('supports restoring persisted webview sessions after VS Code reloads', async () => {
		const packageJson = JSON.parse(await readFile(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { activationEvents?: string[] };
		const extensionSource = await readFile(resolve(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
		const panelSource = await readFile(resolve(__dirname, '..', '..', 'src', 'ui', 'chatPanel.ts'), 'utf8');
		const mainSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.main.js'), 'utf8');
		const stateSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.state.js'), 'utf8');
		const renderingSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.rendering.js'), 'utf8');

		assert.ok(packageJson.activationEvents?.includes('onWebviewPanel:crustChat'));
		assert.match(extensionSource, /CrustChatPanel\.registerSerializer\(context\)/);
		assert.match(panelSource, /registerWebviewPanelSerializer\(CrustChatPanel\.viewType/);
		assert.match(panelSource, /deserializeWebviewPanel: async \(panel, state(?:: unknown)?\) => \{[\s\S]*const shouldRestoreSession = getRestoreOnReloadSetting\(\);[\s\S]*new CrustChatPanel\(context, panel, sessionPath\);/);
		assert.match(panelSource, /switchSession\(this\.restoredSessionPath\)/);
		assert.match(panelSource, /const sessionPath = getSessionPath\(state\);[\s\S]*this\.post\(\{ type: 'sessionPath', sessionPath \}\);/);
		assert.match(mainSource, /case "sessionPath":\s*updatePersistedWebviewState\(\{ sessionPath: message\.sessionPath \|\| undefined \}\);\s*break;/);
		assert.match(stateSource, /let persistedWebviewState = vscode\.getState\(\) \|\| \{\};/);
		assert.match(stateSource, /vscode\.setState\(persistedWebviewState\);/);
		assert.match(renderingSource, /updatePersistedWebviewState\(\{ sessionTitle: title \}\);/);
	});

	test('focuses the prompt when the chat opens', async () => {
		const mainSource = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.main.js'), 'utf8');
		const panelSource = await readFile(resolve(__dirname, '..', '..', 'src', 'ui', 'chatPanel.ts'), 'utf8');

		assert.match(mainSource, /function focusPrompt\(\) \{\s*prompt\.focus\(\);\s*\}/);
		assert.match(mainSource, /window\.setTimeout\(focusPrompt, 0\);[\s\S]*window\.setTimeout\(focusPrompt, 50\);/);
		assert.match(mainSource, /focusPromptSoon\(\);[\s\S]*case "focusPrompt":\s*focusPromptSoon\(\);/);
		assert.match(panelSource, /const chatPanel = new CrustChatPanel\(context, panel\);[\s\S]*chatPanel\.focusPrompt\(\);/);
		assert.doesNotMatch(panelSource, /currentPanel/);
		assert.match(panelSource, /private focusPrompt\(\): void \{\s*this\.post\(\{ type: 'focusPrompt' \}\);\s*\}/);
	});

	test('renders copyable fenced code blocks with clipboard fallback', async () => {
		const source = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.rendering.js'), 'utf8');
		const css = await readFile(resolve(__dirname, '..', '..', 'media', 'chatWebview', 'chatWebview.markdown.css'), 'utf8');

		assert.match(source, /element\.innerHTML = window\.crustMarkdown\.render\(markdown\);/);
		assert.match(source, /function enhanceRenderedMarkdown\(element\)[\s\S]*enhanceTaskListItems\(element\);[\s\S]*wrapCodeBlocks\(element\);[\s\S]*wrapTables\(element\);[\s\S]*hardenLinks\(element\);/);
		assert.match(source, /function setMarkdownSettings\(settings\)[\s\S]*setAllowRawHtml\(settings\.allowRawHtml === true\)[\s\S]*querySelectorAll\("\[data-markdown\]"\)/);
		assert.match(source, /function setChatSettings\(settings\)[\s\S]*includeIdeContextByDefault = settings\.includeIdeContextByDefault === true/);
		assert.match(source, /checkbox\.className = "markdown-task-checkbox";/);
		assert.match(source, /button\.className = "markdown-code-copy";/);
		assert.match(source, /button\.setAttribute\("aria-label", "Copy code block"\);/);
		assert.match(source, /await copyTextToClipboard\(code\.textContent \?\? ""\);/);
		assert.match(source, /navigator\.clipboard[\s\S]*writeText\(text\)/);
		assert.match(source, /document\.execCommand\("copy"\)/);
		assert.match(source, /function createCopyIcon\(\)/);
		assert.match(source, /function isSafeMarkdownUrl\(href\)[\s\S]*url\.protocol === "http:"[\s\S]*url\.protocol === "https:"[\s\S]*url\.protocol === "mailto:"/);
		assert.match(css, /\.markdown-code-block \{[\s\S]*position: relative;/);
		assert.match(css, /\.markdown-code-copy\.copied \{[\s\S]*var\(--vscode-testing-iconPassed/);
	});

	test('injects nonce, CSP source, styles, scripts, and icon into the chat webview template', () => {
		const extensionUri = vscode.Uri.file(resolve(__dirname, '..', '..'));
		const webview = {
			cspSource: 'vscode-resource:',
			asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`vscode-webview://${uri.fsPath}`),
		} as Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'> as vscode.Webview;

		const html = getChatWebviewHtml(extensionUri, webview);
		assert.ok(html.includes('vscode-resource:'));
		assert.ok(html.includes('chatWebview.base.css'));
		assert.ok(html.includes('window.crustInitialSettings = {"allowRawHtml":false,"includeIdeContextByDefault":false}'));
		assert.ok(html.includes('generated/markdown-it.bundle.js'));
		assert.ok(html.indexOf('generated/markdown-it.bundle.js') < html.indexOf('chatWebview.rendering.js'));
		assert.ok(html.includes('chatWebview.main.js'));
		assert.ok(html.includes('branding/icon.svg'));
		assert.ok(!html.includes('{{nonce}}'));
		assert.ok(!html.includes('{{styleTags}}'));
		assert.ok(!html.includes('{{scriptTags}}'));
	});

	test('generates 32-character alphanumeric nonces and stringifies unknown errors', () => {
		const nonce = getNonce();
		assert.match(nonce, /^[A-Za-z0-9]{32}$/);
		assert.notStrictEqual(getNonce(), nonce);
		assert.strictEqual(errorMessage(new Error('boom')), 'boom');
		assert.strictEqual(errorMessage('plain'), 'plain');
	});
});
