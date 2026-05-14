import type { UsageStats } from './chatTypes';

export function formatUsageStatus(messages: unknown[], contextWindow: number | undefined): string {
	return formatUsageStats(getUsageStats(messages), contextWindow);
}

function getUsageStats(messages: unknown[]): UsageStats {
	const stats: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens: 0, cost: 0 };
	for (const message of messages) {
		const usage = getMessageUsage(message);
		if (!usage) {
			continue;
		}
		stats.input += getNumber(usage.input);
		stats.output += getNumber(usage.output);
		stats.cacheRead += getNumber(usage.cacheRead);
		stats.cacheWrite += getNumber(usage.cacheWrite);
		stats.contextTokens = getNumber(usage.totalTokens) || stats.contextTokens;
		stats.totalTokens += getNumber(usage.totalTokens);
		const cost = typeof usage.cost === 'object' && usage.cost !== null ? usage.cost as Record<string, unknown> : undefined;
		stats.cost += getNumber(cost?.total);
	}
	if (!stats.totalTokens) {
		stats.totalTokens = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
	}
	return stats;
}

function getMessageUsage(message: unknown): Record<string, unknown> | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const record = message as { usage?: unknown; message?: unknown };
	const candidate = record.usage ?? (typeof record.message === 'object' && record.message !== null ? (record.message as { usage?: unknown }).usage : undefined);
	return typeof candidate === 'object' && candidate !== null ? candidate as Record<string, unknown> : undefined;
}

function formatUsageStats(stats: UsageStats, contextWindow: number | undefined): string {
	const parts = [
		`${formatTokenCount(stats.totalTokens)}`,
		`${formatTokenCount(stats.input)} in`,
		`${formatTokenCount(stats.output)} out`,
	];
	if (contextWindow) {
		parts.push(formatContextUsage(stats.contextTokens, contextWindow));
	}
	parts.push(formatCost(stats.cost));
	return `${parts.join(' · ')}`;
}

function formatContextUsage(usedTokens: number, availableTokens: number): string {
	const percent = availableTokens > 0 ? (usedTokens / availableTokens) * 100 : 0;
	return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)}%/${formatTokenCount(availableTokens)}`;
}

function formatTokenCount(value: number): string {
	const absolute = Math.abs(value);
	const units = [
		{ suffix: 'T', value: 1_000_000_000_000 },
		{ suffix: 'B', value: 1_000_000_000 },
		{ suffix: 'M', value: 1_000_000 },
		{ suffix: 'k', value: 1_000 },
	];
	const unit = units.find((candidate) => absolute >= candidate.value);
	if (!unit) {
		return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(value));
	}

	const scaled = value / unit.value;
	const maxFractionDigits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(scaled))) - 1);
	return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFractionDigits }).format(scaled)}${unit.suffix}`;
}

function formatCost(value: number): string {
	return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function getNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
