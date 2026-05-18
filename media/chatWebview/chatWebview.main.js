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

function parseExtensionMessage(value) {
	if (!value || typeof value !== "object" || typeof value.type !== "string") {
		return null;
	}
	const arrayValue = (candidate) => Array.isArray(candidate) ? candidate : [];
	const stringValue = (candidate, fallback = "") => typeof candidate === "string" ? candidate : fallback;
	const idMessage = () => typeof value.id === "string" ? value : null;

	switch (value.type) {
		case "models":
			return { type: "models", models: arrayValue(value.models), selected: stringValue(value.selected, undefined) };
		case "slashCommands":
			return { type: "slashCommands", commands: arrayValue(value.commands) };
		case "focusModel":
		case "focusPrompt":
		case "clearMessages":
			return { type: value.type };
		case "pathAutocomplete":
			return typeof value.requestId === "number" ? { type: "pathAutocomplete", requestId: value.requestId, suggestions: arrayValue(value.suggestions) } : null;
		case "status":
		case "error":
			return { type: value.type, message: stringValue(value.message) };
		case "processing":
			return { type: "processing", processing: value.processing === true };
		case "sessionTitle":
			return { type: "sessionTitle", title: stringValue(value.title, "New Chat") };
		case "sessionPath":
			return { type: "sessionPath", sessionPath: stringValue(value.sessionPath, undefined) };
		case "ideContext":
			return { type: "ideContext", label: stringValue(value.label) };
		case "addMessage":
			return typeof value.id === "string" && (value.role === "user" || value.role === "assistant") ? value : null;
		case "appendMessage":
		case "appendThinking":
			return typeof value.id === "string" ? { type: value.type, id: value.id, text: stringValue(value.text) } : null;
		case "removeMessage":
		case "addThinking":
			return idMessage();
		case "upsertTool":
			return typeof value.id === "string" && typeof value.toolName === "string" ? value : null;
		default:
			return null;
	}
}

window.addEventListener("message", (event) => {
	const message = parseExtensionMessage(event.data);
	if (!message) {
		logWebview("Ignored invalid extension message", getMessageLogDetails(event.data), "warn");
		return;
	}
	logWebview("Received extension message", getMessageLogDetails(message));
	switch (message.type) {
		case "models":
			setModels(message.models, message.selected);
			break;
		case "slashCommands":
			setSlashCommands(message.commands);
			break;
		case "focusModel":
			model.focus();
			break;
		case "focusPrompt":
			focusPromptSoon();
			break;
		case "pathAutocomplete":
			setPathSuggestions(message.requestId, message.suggestions);
			break;
		case "status":
			setStatus(message.message, false);
			break;
		case "processing":
			setProcessing(message.processing);
			break;
		case "sessionTitle":
			setSessionTitle(message.title);
			break;
		case "sessionPath":
			updatePersistedWebviewState({ sessionPath: message.sessionPath || undefined });
			break;
		case "error":
			setStatus(message.message, true);
			break;
		case "ideContext":
			setIdeContext(message.label);
			break;
		case "clearMessages":
			messagesContent.textContent = "";
			currentTurn = null;
			setRandomEmptyStateFlavorText();
			updateEmptyState();
			break;
		case "addMessage":
			if (message.role === "user") {
				recordPromptHistory(message.text ?? "");
			}
			addMessage(message.id, message.role, message.text ?? "", message.loading ?? false, message.ideContextLabel ?? "", message.slashCommandLabel ?? "", message.secondary === true);
			break;
		case "appendMessage":
			appendMessage(message.id, message.text);
			break;
		case "removeMessage":
			removeMessage(message.id);
			break;
		case "upsertTool":
			upsertTool(message);
			break;
		case "addThinking":
			addThinking(message.id);
			break;
		case "appendThinking":
			appendThinking(message.id, message.text);
			break;
	}
});
