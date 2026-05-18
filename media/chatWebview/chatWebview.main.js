window.addEventListener("error", (event) => {
	postWebviewLog("Webview error", {
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
	}, "error");
});

window.addEventListener("unhandledrejection", (event) => {
	postWebviewLog("Webview unhandled rejection", { reason: String(event.reason) }, "error");
});

logWebview("Chat webview loaded");
setRandomEmptyStateFlavorText();

function focusPrompt() {
	prompt.focus();
}

function focusPromptSoon() {
	window.setTimeout(focusPrompt, 0);
	window.setTimeout(focusPrompt, 50);
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = prompt.value;
	if (!text.trim()) {
		return;
	}
	recordPromptHistory(text);
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
	requestCancelCurrentTask("button");
});

document.addEventListener("keydown", (event) => {
	if (event.key.toLowerCase() !== "c" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || !piProcessing || hasCopyableSelection()) {
		return;
	}
	event.preventDefault();
	requestCancelCurrentTask("keyboard");
});

function requestCancelCurrentTask(source) {
	logWebview("Cancelling prompt", { source });
	vscode.postMessage({ type: "cancel" });
}

function hasCopyableSelection() {
	if (document.activeElement === prompt && prompt.selectionStart !== prompt.selectionEnd) {
		return true;
	}
	const selection = window.getSelection();
	return Boolean(selection && !selection.isCollapsed && selection.toString());
}

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
	if (!restoringPromptHistory) {
		promptHistoryCursor = promptHistory.length;
		promptHistoryDraft = "";
	}
	autoResizePrompt();
	updateSlashAutocomplete();
	updateSubmitButton();
});
prompt.addEventListener("focus", updateSlashAutocomplete);
prompt.addEventListener("blur", () => {
	window.setTimeout(hideSlashAutocomplete, 100);
});

function recordPromptHistory(text) {
	const entry = text.trim();
	if (!entry || promptHistory[promptHistory.length - 1] === entry) {
		promptHistoryCursor = promptHistory.length;
		return;
	}
	promptHistory.push(entry);
	if (promptHistory.length > 100) {
		promptHistory = promptHistory.slice(-100);
	}
	promptHistoryCursor = promptHistory.length;
	promptHistoryDraft = "";
	updatePersistedWebviewState({ promptHistory });
}

function handlePromptHistoryKeydown(event) {
	if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
		return false;
	}
	if (event.key === "ArrowUp") {
		if (!isCursorBeforePromptText() || promptHistory.length === 0) {
			return false;
		}
		if (promptHistoryCursor === promptHistory.length) {
			promptHistoryDraft = prompt.value;
		}
		if (promptHistoryCursor <= 0) {
			return false;
		}
		setPromptFromHistory(promptHistoryCursor - 1);
		event.preventDefault();
		return true;
	}
	if (!isCursorAfterPromptText() || promptHistoryCursor >= promptHistory.length) {
		return false;
	}
	event.preventDefault();
	if (promptHistoryCursor === promptHistory.length - 1) {
		setPromptValueFromHistory(promptHistoryDraft);
		promptHistoryCursor = promptHistory.length;
		promptHistoryDraft = "";
		return true;
	}
	setPromptFromHistory(promptHistoryCursor + 1);
	return true;
}

function isCursorBeforePromptText() {
	return prompt.selectionStart === 0 && prompt.selectionEnd === 0;
}

function isCursorAfterPromptText() {
	return prompt.selectionStart === prompt.value.length && prompt.selectionEnd === prompt.value.length;
}

function setPromptFromHistory(index) {
	promptHistoryCursor = index;
	setPromptValueFromHistory(promptHistory[index] ?? "");
}

function setPromptValueFromHistory(value) {
	restoringPromptHistory = true;
	prompt.value = value;
	prompt.setSelectionRange(prompt.value.length, prompt.value.length);
	autoResizePrompt();
	updateSlashAutocomplete();
	updateSubmitButton();
	restoringPromptHistory = false;
}

ideContext.addEventListener("click", toggleIdeContext);

prompt.addEventListener("keydown", (event) => {
	if (handleSlashAutocompleteKeydown(event)) {
		return;
	}
	if (handlePromptHistoryKeydown(event)) {
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
focusPromptSoon();

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
	if (message.type === "focusPrompt") {
		focusPromptSoon();
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
	if (message.type === "sessionPath") {
		updatePersistedWebviewState({ sessionPath: message.sessionPath || undefined });
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
		if (message.role === "user") {
			recordPromptHistory(message.text ?? "");
		}
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
