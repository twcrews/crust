import fs from 'node:fs';

const WIDGET_ID = 'crust-ide-context';
const WIDGET_REFRESH_MS = 1000;

async function reportTerminalSession(ctx) {
	const terminalId = process.env.CRUST_TERMINAL_ID;
	const bridgeUrl = process.env.CRUST_BRIDGE_URL;
	const bridgeToken = process.env.CRUST_BRIDGE_TOKEN;
	const sessionFile = ctx?.sessionManager?.getSessionFile?.();
	if (!terminalId || !bridgeUrl || !bridgeToken || !sessionFile) return;
	try {
		await fetch(`${bridgeUrl}/terminal-session`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${bridgeToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ terminalId, sessionFile }),
		});
	} catch {
		// Best-effort session restoration metadata.
	}
}

function readContext(filePath) {
	if (!filePath) return undefined;
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch {
		return undefined;
	}
}

function formatContextLabel(context) {
	if (!context?.filePath) return undefined;
	return context.selectionRange ? `${context.filePath}:${context.selectionRange}` : context.filePath;
}

function truncateMiddle(text, width) {
	if (width <= 0) return '';
	if (text.length <= width) return text;
	if (width <= 1) return '…';
	const keep = width - 1;
	const front = Math.ceil(keep * 0.6);
	const back = Math.max(0, keep - front);
	return `${text.slice(0, front)}…${back ? text.slice(-back) : ''}`;
}

function buildContextWidget(context, contextEnabled) {
	const label = formatContextLabel(context);
	if (!label) {
		return () => ({
			invalidate() {},
			render() {
				return [];
			},
		});
	}
	const kind = context.selectionRange && context.selectedText !== undefined ? 'selection' : 'file';
	if (!contextEnabled) {
		return (_tui, theme) => ({
			invalidate() {},
			render(width) {
				const text = `${kind}: ${label}`;
				return [theme.strikethrough(theme.fg('muted', truncateMiddle(text, width)))];
			},
		});
	}
	return (_tui, theme) => ({
		invalidate() {},
		render(width) {
			const text = `${kind}: ${label}`;
			return [theme.fg('accent', truncateMiddle(text, width))];
		},
	});
}

function buildContextMessage(context) {
	if (!context || !context.filePath) return undefined;
	const lines = [
		'<ide_context>',
	];
	if (context.workspaceRoot) {
		lines.push(`Workspace root: ${context.workspaceRoot}`);
	}
	lines.push(`Current file: ${context.filePath}`);
	if (context.selectionRange && context.selectedText !== undefined) {
		lines.push(
			`Selected lines: ${context.selectionRange}`,
			'Selected text:',
			`\`\`\`${context.languageId || ''}`,
			context.selectedText,
			'```',
		);
	}
	lines.push('</ide_context>');
	return lines.join('\n');
}

export default function (pi) {
	const contextFile = process.env.CRUST_IDE_CONTEXT_FILE;
	if (!contextFile) return;

	let contextEnabled = process.env.CRUST_IDE_CONTEXT_ENABLED === '1';
	let widgetTimer;
	let lastWidgetKey;

	const refreshWidget = (ctx) => {
		if (!ctx?.hasUI) return;
		const context = readContext(contextFile);
		const label = formatContextLabel(context);
		const widgetKey = `${contextEnabled ? 'on' : 'off'}:${label || ''}:${context?.selectedText !== undefined}`;
		if (widgetKey === lastWidgetKey) return;
		lastWidgetKey = widgetKey;
		ctx.ui.setWidget(WIDGET_ID, buildContextWidget(context, contextEnabled));
	};

	const startWidgetUpdates = (ctx) => {
		if (!ctx?.hasUI) return;
		if (widgetTimer) clearInterval(widgetTimer);
		lastWidgetKey = undefined;
		refreshWidget(ctx);
		widgetTimer = setInterval(() => refreshWidget(ctx), WIDGET_REFRESH_MS);
	};

	const stopWidgetUpdates = (ctx) => {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
		lastWidgetKey = undefined;
		if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
	};

	pi.registerCommand('ide-context', {
		description: 'Toggle IDE file/selection context injection',
		getArgumentCompletions: (prefix) => ['on', 'off', 'toggle', 'status']
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = String(args || '').trim().toLowerCase();
			if (action === 'on') {
				contextEnabled = true;
			} else if (action === 'off') {
				contextEnabled = false;
			} else if (action !== 'status') {
				contextEnabled = !contextEnabled;
			}
			lastWidgetKey = undefined;
			refreshWidget(ctx);
			ctx.ui.notify(`Crust IDE context ${contextEnabled ? 'enabled' : 'disabled'}`, 'info');
		},
	});

	pi.on('session_start', async (_event, ctx) => {
		startWidgetUpdates(ctx);
		await reportTerminalSession(ctx);
	});

	pi.on('input', async (_event, ctx) => {
		refreshWidget(ctx);
	});

	pi.on('before_agent_start', async (_event, ctx) => {
		refreshWidget(ctx);
		if (!contextEnabled) return undefined;
		const content = buildContextMessage(readContext(contextFile));
		if (!content) return undefined;
		return {
			message: {
				customType: 'crust-ide-context',
				content,
				display: false,
			},
		};
	});

	pi.on('agent_end', async (_event, ctx) => {
		refreshWidget(ctx);
	});

	pi.on('session_shutdown', async (_event, ctx) => {
		stopWidgetUpdates(ctx);
	});
}
