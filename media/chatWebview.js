const vscode = acquireVsCodeApi();
const sessionTitle = document.getElementById("session-title");
const messages = document.getElementById("messages");
const messagesContent = document.getElementById("messages-content");
const emptyState = document.getElementById("empty-state");
const form = document.getElementById("form");
const prompt = document.getElementById("prompt");
const ideContext = document.getElementById("ide-context");
const ideContextLabel = document.getElementById("ide-context-label");
const model = document.getElementById("model");
const status = document.getElementById("status");
const history = document.getElementById("history");
const newChat = document.getElementById("new-chat");
const jumpTop = document.getElementById("jump-top");
const jumpPreviousUser = document.getElementById("jump-previous-user");
const jumpNextUser = document.getElementById("jump-next-user");
const jumpBottom = document.getElementById("jump-bottom");
let ideContextEnabled = true;
let currentIdeContextLabel = "";
let currentTurn = null;

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

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = prompt.value;
	if (!text.trim()) {
		return;
	}
	prompt.value = "";
	autoResizePrompt();
	logWebview("Submitting prompt", { length: text.trim().length, includeIdeContext: ideContextEnabled && !ideContext.classList.contains("hidden") });
	vscode.postMessage({ type: "submit", text, includeIdeContext: ideContextEnabled && !ideContext.classList.contains("hidden") });
});

prompt.addEventListener("input", autoResizePrompt);

ideContext.addEventListener("click", () => {
	ideContextEnabled = !ideContextEnabled;
	updateIdeContextButtonState();
});

prompt.addEventListener("keydown", (event) => {
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
	if (message.type === "status") {
		setStatus(message.message ?? "", false);
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
		updateEmptyState();
	}
	if (message.type === "addMessage") {
		addMessage(message.id, message.role, message.text ?? "", message.loading ?? false, message.ideContextLabel ?? "");
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

function setSessionTitle(title) {
	sessionTitle.textContent = title;
	sessionTitle.title = title;
}

function setModels(models, selected) {
	model.textContent = "";
	if (!models.length) {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "No configured models found";
		model.append(option);
		return;
	}
	for (const candidate of models) {
		const option = document.createElement("option");
		option.value = candidate.provider + "/" + candidate.id;
		option.textContent =
			(candidate.name || candidate.id) + " (" + candidate.provider + ")";
		model.append(option);
	}
	if (selected) {
		model.value = selected;
	}
}

function addMessage(id, role, text, loading, ideContextLabel) {
	const element = document.createElement("div");
	element.id = id;
	element.className = "message " + role + (loading ? " loading" : "");
	if (role === "assistant" && !loading) {
		setMarkdownContent(element, text);
	} else if (role === "user") {
		renderUserMessage(element, text, ideContextLabel);
	} else {
		element.textContent = text;
	}
	appendConversationElement(element, role === "user");
	if (role === "user") {
		initUserMessageToggle(element);
	}
	updateEmptyState();
	keepLoadingAtBottom();
	finishContentUpdate();
}

function renderUserMessage(element, text, ideContextLabel) {
	if (ideContextLabel) {
		const context = document.createElement("div");
		context.className = "message-context";
		context.title = ideContextLabel;
		context.append(createEyeIcon());
		const label = document.createElement("span");
		label.textContent = ideContextLabel;
		context.append(label);
		element.append(context);
	}

	const body = document.createElement("div");
	body.className = "user-message-body";
	body.textContent = text;
	element.append(body);

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "user-message-toggle";
	toggle.textContent = "Show more";
	toggle.setAttribute("aria-expanded", "false");
	toggle.hidden = true;
	toggle.addEventListener("click", () => {
		const expanded = element.classList.toggle("expanded");
		toggle.textContent = expanded ? "Show less" : "Show more";
		toggle.setAttribute("aria-expanded", String(expanded));
		finishContentUpdate();
	});
	element.append(toggle);
}

function initUserMessageToggle(element) {
	const body = element.querySelector(".user-message-body");
	const toggle = element.querySelector(".user-message-toggle");
	if (!body || !toggle) {
		return;
	}
	element.classList.add("collapsible");
	const overflows = body.scrollHeight > body.clientHeight + 1;
	toggle.hidden = !overflows;
	if (!overflows) {
		element.classList.remove("collapsible");
	}
}

function appendConversationElement(element, startsTurn) {
	if (startsTurn) {
		if (messagesContent.querySelector(".message.user")) {
			const divider = document.createElement("div");
			divider.className = "user-prompt-divider";
			divider.setAttribute("aria-hidden", "true");
			messagesContent.append(divider);
		}
		currentTurn = document.createElement("section");
		currentTurn.className = "conversation-turn";
		messagesContent.append(currentTurn);
	}

	if (currentTurn) {
		currentTurn.append(element);
		return;
	}
	messagesContent.append(element);
}

function createEyeIcon() {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("width", "14");
	svg.setAttribute("height", "14");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("fill", "none");

	const eye = document.createElementNS("http://www.w3.org/2000/svg", "path");
	eye.setAttribute("d", "M1.75 8S4 4.25 8 4.25S14.25 8 14.25 8S12 11.75 8 11.75S1.75 8 1.75 8Z");
	eye.setAttribute("stroke", "currentColor");
	eye.setAttribute("stroke-width", "1.3");
	eye.setAttribute("stroke-linecap", "round");
	eye.setAttribute("stroke-linejoin", "round");
	svg.append(eye);

	const pupil = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	pupil.setAttribute("cx", "8");
	pupil.setAttribute("cy", "8");
	pupil.setAttribute("r", "1.75");
	pupil.setAttribute("stroke", "currentColor");
	pupil.setAttribute("stroke-width", "1.3");
	svg.append(pupil);
	return svg;
}

function appendMessage(id, text) {
	const element = document.getElementById(id);
	if (!element) {
		return;
	}
	element.classList.remove("loading");
	if (element.classList.contains("assistant")) {
		setMarkdownContent(element, (element.dataset.markdown ?? "") + text);
	} else {
		element.textContent += text;
	}
	keepLoadingAtBottom();
	finishContentUpdate();
}

function removeMessage(id) {
	const element = document.getElementById(id);
	if (!element) {
		return;
	}
	element.remove();
	updateEmptyState();
	updateConversationNavButtons();
}

function addThinking(id) {
	const element = document.createElement("section");
	element.id = id;
	element.className = "thinking-card";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "thinking-toggle";
	button.setAttribute("aria-expanded", "false");

	const chevron = document.createElement("span");
	chevron.className = "thinking-chevron";
	chevron.setAttribute("aria-hidden", "true");
	button.append(chevron);

	const label = document.createElement("span");
	label.textContent = "Show thinking";
	button.append(label);

	button.addEventListener("click", () => {
		const expanded = element.classList.toggle("expanded");
		button.setAttribute("aria-expanded", String(expanded));
		label.textContent = expanded ? "Hide thinking" : "Show thinking";
	});
	element.append(button);

	const body = document.createElement("div");
	body.className = "thinking-body";
	element.append(body);
	appendConversationElement(element, false);
	updateEmptyState();
	keepLoadingAtBottom();
	finishContentUpdate();
}

function appendThinking(id, text) {
	const body = document.querySelector("#" + CSS.escape(id) + " .thinking-body");
	if (!body) {
		return;
	}
	setMarkdownContent(body, (body.dataset.markdown ?? "") + text);
	keepLoadingAtBottom();
	finishContentUpdate();
}

function setMarkdownContent(element, markdown) {
	element.dataset.markdown = markdown;
	renderMarkdown(element, markdown);
}

function renderMarkdown(element, markdown) {
	element.textContent = "";
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let index = 0;
	let paragraph = [];

	function flushParagraph() {
		if (!paragraph.length) {
			return;
		}
		const p = document.createElement("p");
		renderInline(p, paragraph.join("\n"));
		element.append(p);
		paragraph = [];
	}

	while (index < lines.length) {
		const line = lines[index];
		const fence = line.match(/^\s*```(.*)$/);
		if (fence) {
			flushParagraph();
			index++;
			const codeLines = [];
			while (index < lines.length && !/^\s*```/.test(lines[index])) {
				codeLines.push(lines[index]);
				index++;
			}
			if (index < lines.length) {
				index++;
			}
			const pre = document.createElement("pre");
			const code = document.createElement("code");
			code.textContent = codeLines.join("\n");
			pre.append(code);
			element.append(pre);
			continue;
		}

		if (!line.trim()) {
			flushParagraph();
			index++;
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			flushParagraph();
			const headingElement = document.createElement("h" + heading[1].length);
			renderInline(headingElement, heading[2]);
			element.append(headingElement);
			index++;
			continue;
		}

		if (isMarkdownDivider(line)) {
			flushParagraph();
			element.append(document.createElement("hr"));
			index++;
			continue;
		}

		if (isTableStart(lines, index)) {
			flushParagraph();
			const tableResult = renderTable(lines, index);
			element.append(tableResult.element);
			index = tableResult.nextIndex;
			continue;
		}

		const listItem = line.match(/^\s*[-*+]\s+(.+)$/);
		if (listItem) {
			flushParagraph();
			const list = document.createElement("ul");
			while (index < lines.length) {
				const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
				if (!item) {
					break;
				}
				const li = document.createElement("li");
				renderInline(li, item[1]);
				list.append(li);
				index++;
			}
			element.append(list);
			continue;
		}

		const quote = line.match(/^>\s?(.*)$/);
		if (quote) {
			flushParagraph();
			const blockquote = document.createElement("blockquote");
			const quoteLines = [];
			while (index < lines.length) {
				const quoteLine = lines[index].match(/^>\s?(.*)$/);
				if (!quoteLine) {
					break;
				}
				quoteLines.push(quoteLine[1]);
				index++;
			}
			renderInline(blockquote, quoteLines.join("\n"));
			element.append(blockquote);
			continue;
		}

		paragraph.push(line);
		index++;
	}
	flushParagraph();
}

function isMarkdownDivider(line) {
	return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isTableStart(lines, index) {
	return index + 1 < lines.length && hasTablePipe(lines[index]) && isTableSeparatorLine(lines[index + 1]);
}

function hasTablePipe(line) {
	return /(^|[^\\])\|/.test(line);
}

function isTableSeparatorLine(line) {
	const cells = splitTableRow(line).map((cell) => cell.trim());
	return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line) {
	let value = line.trim();
	if (value.startsWith("|")) {
		value = value.slice(1);
	}
	if (value.endsWith("|") && !value.endsWith("\\|")) {
		value = value.slice(0, -1);
	}

	const cells = [];
	let current = "";
	let escaped = false;
	for (const character of value) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	if (escaped) {
		current += "\\";
	}
	cells.push(current.trim());
	return cells;
}

function renderTable(lines, startIndex) {
	const headers = splitTableRow(lines[startIndex]);
	const alignments = splitTableRow(lines[startIndex + 1]).map((cell) => {
		const trimmed = cell.trim();
		if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
			return "center";
		}
		if (trimmed.endsWith(":")) {
			return "right";
		}
		if (trimmed.startsWith(":")) {
			return "left";
		}
		return "";
	});
	let index = startIndex + 2;

	const wrapper = document.createElement("div");
	wrapper.className = "markdown-table-wrapper";
	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const headerRow = document.createElement("tr");
	for (const [cellIndex, header] of headers.entries()) {
		const th = document.createElement("th");
		if (alignments[cellIndex]) {
			th.style.textAlign = alignments[cellIndex];
		}
		renderInline(th, header);
		headerRow.append(th);
	}
	thead.append(headerRow);
	table.append(thead);

	const tbody = document.createElement("tbody");
	while (index < lines.length && lines[index].trim() && hasTablePipe(lines[index])) {
		const row = document.createElement("tr");
		const cells = splitTableRow(lines[index]);
		for (let cellIndex = 0; cellIndex < headers.length; cellIndex++) {
			const td = document.createElement("td");
			if (alignments[cellIndex]) {
				td.style.textAlign = alignments[cellIndex];
			}
			renderInline(td, cells[cellIndex] ?? "");
			row.append(td);
		}
		tbody.append(row);
		index++;
	}
	table.append(tbody);
	wrapper.append(table);
	return { element: wrapper, nextIndex: index };
}

function renderInline(element, text) {
	const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
	let lastIndex = 0;
	for (const match of text.matchAll(pattern)) {
		appendInlineText(element, text.slice(lastIndex, match.index));
		const token = match[0];
		if (token.startsWith("`")) {
			const code = document.createElement("code");
			code.textContent = token.slice(1, -1);
			element.append(code);
		} else if (token.startsWith("**") || token.startsWith("__")) {
			const strong = document.createElement("strong");
			strong.textContent = token.slice(2, -2);
			element.append(strong);
		} else {
			const emphasis = document.createElement("em");
			emphasis.textContent = token.slice(1, -1);
			element.append(emphasis);
		}
		lastIndex = match.index + token.length;
	}
	appendInlineText(element, text.slice(lastIndex));
}

function appendInlineText(element, text) {
	const parts = text.split("\n");
	for (const [index, part] of parts.entries()) {
		if (index > 0) {
			element.append(document.createElement("br"));
		}
		element.append(document.createTextNode(part));
	}
}

function upsertTool(message) {
	let element = document.getElementById(message.id);
	if (!element) {
		element = document.createElement("section");
		element.id = message.id;
		element.className = "tool-card";

		const header = document.createElement("div");
		header.className = "tool-header";
		element.append(header);

		const body = document.createElement("pre");
		body.className = "tool-body";
		element.append(body);
		appendConversationElement(element, false);
		updateEmptyState();
	}

	const hasBody = Boolean(message.body);
	element.className = "tool-card " + (message.status ?? "");
	element.classList.toggle("no-body", !hasBody);
	const header = element.querySelector(".tool-header");
	const body = element.querySelector(".tool-body");
	const path = message.path ? " " + message.path : "";
	header.textContent = (message.toolName ?? "tool") + path + formatToolStatus(message.status);
	header.title = header.textContent;
	renderToolBody(body, message.body ?? "", Boolean(message.isDiff), message.path);
	body.hidden = !hasBody;
	body.classList.toggle("diff", Boolean(message.isDiff));
	keepLoadingAtBottom();
	finishContentUpdate();
}

function renderToolBody(body, text, isDiff) {
	body.textContent = "";
	if (!isDiff) {
		body.textContent = text;
		return;
	}

	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const lineElement = document.createElement("span");
		lineElement.className = "diff-line";
		if (line.startsWith("+") && !line.startsWith("+++")) {
			lineElement.classList.add("added");
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			lineElement.classList.add("deleted");
		}
		lineElement.textContent = line;
		body.append(lineElement);
		if (index < lines.length - 1) {
			body.append(document.createTextNode("\n"));
		}
	}
}

function formatToolStatus(status) {
	if (status === "drafting") {
		return " · drafting";
	}
	if (status === "pending") {
		return " · pending";
	}
	if (status === "running") {
		return " · running";
	}
	if (status === "error") {
		return " · error";
	}
	return "";
}

function setStatus(message, isError) {
	status.textContent = message;
	status.className = "status" + (isError ? " error" : "");
}

function setIdeContext(label) {
	ideContextLabel.textContent = label;
	ideContext.title = label ? "Toggle IDE context: " + label : "Use IDE context";
	ideContext.classList.toggle("hidden", !label);
	if (!label || label !== currentIdeContextLabel) {
		ideContextEnabled = true;
	}
	currentIdeContextLabel = label;
	updateIdeContextButtonState();
}

function updateIdeContextButtonState() {
	ideContext.classList.toggle("disabled", !ideContextEnabled);
	ideContext.setAttribute("aria-pressed", String(ideContextEnabled));
}

function autoResizePrompt() {
	prompt.style.height = "28px";
	prompt.style.height = Math.max(28, Math.min(prompt.scrollHeight, 180)) + "px";
	prompt.style.overflowY = prompt.scrollHeight > 180 ? "auto" : "hidden";
}

function jumpToUserPrompt(direction) {
	const prompts = Array.from(messagesContent.querySelectorAll(".message.user"));
	const threshold = 8;
	const currentTop = messages.scrollTop;
	let target;

	for (const promptElement of prompts) {
		const promptTop = getPromptSectionScrollTop(promptElement);
		if (direction === "previous" && promptTop < currentTop - threshold) {
			target = promptElement;
		}
		if (direction === "next" && promptTop > currentTop + threshold) {
			target = promptElement;
			break;
		}
	}

	if (target) {
		scrollMessagesTo(getPromptSectionScrollTop(target), true);
		return;
	}
	if (direction === "next") {
		scrollToBottom(true);
	}
}

function getPromptSectionScrollTop(promptElement) {
	return getMessageScrollTop(promptElement.closest(".conversation-turn") ?? promptElement);
}

function getMessageScrollTop(element) {
	return Math.max(
		0,
		element.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop - 16,
	);
}

function updateEmptyState() {
	emptyState.classList.toggle("hidden", messagesContent.childElementCount > 0);
}

function updateConversationNavButtons() {
	const threshold = 2;
	const atTop = messages.scrollTop <= threshold;
	const atBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - threshold;

	jumpTop.disabled = atTop;
	jumpPreviousUser.disabled = atTop;
	jumpNextUser.disabled = atBottom;
	jumpBottom.disabled = atBottom;
}

function keepLoadingAtBottom() {
	const loading = messagesContent.querySelector(".message.loading");
	const parent = loading?.parentElement;
	if (loading && parent && loading !== parent.lastElementChild) {
		parent.append(loading);
	}
}

function finishContentUpdate() {
	scrollToBottom();
}

function scrollMessagesTo(top, smooth) {
	messages.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
	updateConversationNavButtons();
}

function scrollToBottom(smooth = false) {
	scrollMessagesTo(messages.scrollHeight, smooth);
}
