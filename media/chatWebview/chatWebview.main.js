window.addEventListener("error", (event) => {
	postWebviewLog("Webview error", {
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
	});
});

window.addEventListener("unhandledrejection", (event) => {
	postWebviewLog("Webview unhandled rejection", { reason: String(event.reason) });
});

logWebview("Chat webview loaded");
setRandomEmptyStateFlavorText();

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = prompt.value;
	if (!text.trim()) {
		return;
	}
	if (!piProcessing && runSlashCommand(text)) {
		return;
	}
	prompt.value = "";
	autoResizePrompt();
	updateSlashAutocomplete();
	updateSubmitButton();
	if (piProcessing) {
		logWebview("Steering prompt", { length: text.trim().length });
		vscode.postMessage({ type: "steer", text });
		return;
	}
	setProcessing(true);
	logWebview("Submitting prompt", { length: text.trim().length, includeIdeContext: ideContextEnabled && !ideContext.classList.contains("hidden") });
	vscode.postMessage({ type: "submit", text, includeIdeContext: ideContextEnabled && !ideContext.classList.contains("hidden") });
});

submit.addEventListener("click", (event) => {
	if (!piProcessing || prompt.value.trim()) {
		return;
	}
	event.preventDefault();
	logWebview("Cancelling prompt");
	vscode.postMessage({ type: "cancel" });
});

function setProcessing(isProcessing) {
	piProcessing = Boolean(isProcessing);
	prompt.placeholder = piProcessing ? "Steer Pi's current task..." : "Ask Pi...";
	updateSubmitButton();
}

function updateSubmitButton() {
	const isStop = piProcessing && !prompt.value.trim();
	submit.classList.toggle("stop", isStop);
	submit.setAttribute("aria-label", isStop ? "Stop Pi" : "Submit prompt");
	submit.title = isStop ? "Stop Pi" : "Submit prompt";
}

prompt.addEventListener("input", () => {
	autoResizePrompt();
	updateSlashAutocomplete();
	updateSubmitButton();
});
prompt.addEventListener("focus", updateSlashAutocomplete);
prompt.addEventListener("blur", () => {
	window.setTimeout(hideSlashAutocomplete, 100);
});

ideContext.addEventListener("click", toggleIdeContext);

prompt.addEventListener("keydown", (event) => {
	if (handleSlashAutocompleteKeydown(event)) {
		return;
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		form.requestSubmit();
	}
});

model.addEventListener("change", () => {
	vscode.postMessage({ type: "selectModel", modelKey: model.value });
});

history.addEventListener("click", () => {
	vscode.postMessage({ type: "showHistory" });
});

newChat.addEventListener("click", () => {
	vscode.postMessage({ type: "newChat" });
});

jumpTop.addEventListener("click", () => {
	scrollMessagesTo(0, true);
});

jumpPreviousUser.addEventListener("click", () => {
	jumpToUserPrompt("previous");
});

jumpNextUser.addEventListener("click", () => {
	jumpToUserPrompt("next");
});

jumpBottom.addEventListener("click", () => {
	scrollToBottom(true);
});

messages.addEventListener("scroll", updateConversationNavButtons);
updateEmptyState();
updateConversationNavButtons();

window.addEventListener("message", (event) => {
	const message = event.data;
	logWebview("Received extension message", getMessageLogDetails(message));
	if (message.type === "models") {
		setModels(message.models ?? [], message.selected);
	}
	if (message.type === "slashCommands") {
		setSlashCommands(message.commands ?? []);
	}
	if (message.type === "focusModel") {
		model.focus();
	}
	if (message.type === "pathAutocomplete") {
		setPathSuggestions(message.requestId, message.suggestions ?? []);
	}
	if (message.type === "status") {
		setStatus(message.message ?? "", false);
	}
	if (message.type === "processing") {
		setProcessing(message.processing === true);
	}
	if (message.type === "sessionTitle") {
		setSessionTitle(message.title ?? "New Chat");
	}
	if (message.type === "error") {
		setStatus(message.message ?? "", true);
	}
	if (message.type === "ideContext") {
		setIdeContext(message.label ?? "");
	}
	if (message.type === "clearMessages") {
		messagesContent.textContent = "";
		currentTurn = null;
		setRandomEmptyStateFlavorText();
		updateEmptyState();
	}
	if (message.type === "addMessage") {
		addMessage(message.id, message.role, message.text ?? "", message.loading ?? false, message.ideContextLabel ?? "", message.slashCommandLabel ?? "", message.secondary === true);
	}
	if (message.type === "appendMessage") {
		appendMessage(message.id, message.text ?? "");
	}
	if (message.type === "removeMessage") {
		removeMessage(message.id);
	}
	if (message.type === "upsertTool") {
		upsertTool(message);
	}
	if (message.type === "addThinking") {
		addThinking(message.id);
	}
	if (message.type === "appendThinking") {
		appendThinking(message.id, message.text ?? "");
	}
});
