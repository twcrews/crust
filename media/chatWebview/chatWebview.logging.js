function shouldLogWebview(level = "info") {
	return level === "warn" || level === "error";
}

function logWebview(message, details, level = "info") {
	if (!shouldLogWebview(level)) {
		return;
	}
	const consoleMethod = level === "error" ? console.error : console.warn;
	if (details === undefined) {
		consoleMethod("[Crust]", message);
		return;
	}
	consoleMethod("[Crust]", message, details);
}

function postWebviewLog(message, details, level = "info") {
	logWebview(message, details, level);
	if (shouldLogWebview(level)) {
		vscode.postMessage({ type: "webviewLog", message, details, level });
	}
}

function getMessageLogDetails(message) {
	return {
		type: message?.type,
		id: message?.id,
		role: message?.role,
		status: message?.status,
		textLength: typeof message?.text === "string" ? message.text.length : undefined,
		bodyLength: typeof message?.body === "string" ? message.body.length : undefined,
	};
}
