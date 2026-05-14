function logWebview(message, details) {
	if (details === undefined) {
		console.log("[Crust]", message);
		return;
	}
	console.log("[Crust]", message, details);
}

function postWebviewLog(message, details) {
	logWebview(message, details);
	vscode.postMessage({ type: "webviewLog", message, details });
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
