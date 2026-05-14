const vscode = acquireVsCodeApi();
const sessionTitle = document.getElementById("session-title");
const messages = document.getElementById("messages");
const messagesContent = document.getElementById("messages-content");
const emptyState = document.getElementById("empty-state");
const emptyStateText = document.getElementById("empty-state-text");
const form = document.getElementById("form");
const prompt = document.getElementById("prompt");
const slashAutocomplete = document.getElementById("slash-autocomplete");
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
let slashCommands = [];
let slashSuggestions = [];
let activeSlashSuggestionIndex = 0;
let autocompleteMode = "";
let pathAutocompleteRequestId = 0;
let latestPathAutocompleteRequestId = 0;

const emptyStateFlavorTexts = [
	"Fun fact: this extension was almost named 'Circumference'!",
	"Pi is irrational, but your conversations with it don't have to be.",
	"There are many AI extensions, but this one is yours.",
	"This extension was built with Pi. How meta!",
	"It's called 'Crust'. Get it? Because the Pi is inside the Crust? No? Just me? Okay.",
	"The creator of this extension has memorized Pi up to 35 digits. Can you beat that?",
	"Pi is cooling on the windowsill, ready when you are.",
	"Ask a question. Summon a diff. Pretend this was your plan all along.",
	"Fresh chat, flaky crust, infinite filling potential.",
	"No crumbs yet. Start typing and make a mess.",
	"Pi has entered the chat. The chat has not yet entered Pi.",
	"A blank canvas, but with more semicolons lurking nearby.",
	"Tell Pi what broke. It promises not to say 'works on my machine.'",
	"Start anywhere. Pi is unusually tolerant of vague requirements.",
	"Your workspace has questions. Pi brought a fork.",
	"Begin the ritual: prompt, wait, nod thoughtfully.",
	"Vibe coding has never been so tasty.",
	"New chat smell. Slight notes of code and optimism.",
	"Pi is preheating. Add one prompt and stir.",
	"Ask nicely, or ask in all caps. Pi has seen production logs.",
	"Your next great commit starts with an unreasonable request.",
	"Pi can explain the code. Understanding it is still a team sport.",
	"Drop a prompt. Watch the crust rise.",
	"A fresh slice of context is waiting.",
	"The repo is quiet. Too quiet...",
	"No messages yet. Enjoy this rare moment of quiet.",
	"Pi accepts prompts, context, and the occasional existential crisis.",
	"Pi is ready to go into the oven.",
	"Every refactor begins with denial.",
	"Crack open the crust and see what's baking.",
	"Pi won't judge your branch name. Probably.",
	"There are no bad questions, only bad dependency graphs.",
	"Here lies an empty chat, full of unrealized bugs and side effects.",
	"Ask Pi anything. Maybe not about floating point equality.",
	"The best time to write tests was yesterday. The second best time is now.",
	"A blank slate, a full repo, and absolutely no pressure.",
	"Pi is listening. The linter is pretending not to.",
	"Start a chat. Future you needs plausible deniability.",
	"Pi is warmed up and ready to overthink edge cases.",
	"Type boldly. Git remembers everything.",
	"The crust is crisp. The context window is hungry.",
	"Bring a task, a trace, or a mildly haunted function.",
	"Pi has opinions. Some of them compile.",
	"Nothing here yet except possibility and CSS.",
	"Ask Pi to make it work, then make it pretty, then make it someone else's problem.",
	"This is where the magic happens. Also the off-by-one errors.",
	"Begin with a question. End with a suspiciously large diff.",
	"Pi brought snacks for the dependency graph.",
	"Your move, human.",
	"Prompt first. Ask questions during code review.",
	"Empty chat, full send.",
	"This sentence is false. Hey, I didn't crash!",
	"Pi is ready to build your abstract-prototype-singleton-proxy-adapter-factory pattern."
];

setRandomEmptyStateFlavorText();

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
	if (runSlashCommand(text)) {
		return;
	}
	prompt.value = "";
	autoResizePrompt();
	updateSlashAutocomplete();
	logWebview("Submitting prompt", { length: text.trim().length, includeIdeContext: ideContextEnabled && !ideContext.classList.contains("hidden") });
	vscode.postMessage({ type: "submit", text, includeIdeContext: ideContextEnabled && !ideContext.classList.contains("hidden") });
});

prompt.addEventListener("input", () => {
	autoResizePrompt();
	updateSlashAutocomplete();
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

function toggleIdeContext() {
	if (ideContext.classList.contains("hidden")) {
		return;
	}
	ideContextEnabled = !ideContextEnabled;
	updateIdeContextButtonState();
}

function setSlashCommands(commands) {
	slashCommands = commands
		.filter((command) => typeof command?.name === "string" && command.name.trim())
		.map((command) => ({
			name: command.name,
			command: "/" + command.name,
			description: command.description || formatSlashCommandSource(command),
			source: command.source,
		}));
	updateSlashAutocomplete();
}

function formatSlashCommandSource(command) {
	const parts = [command.source, command.location].filter((part) => typeof part === "string" && part);
	return parts.join(" · ");
}

function runSlashCommand(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return false;
	}
	const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
	const command = slashCommands.find((candidate) => candidate.name === commandName);
	if (!command) {
		setStatus("Unknown slash command: " + trimmed, true);
		return true;
	}
	prompt.value = "";
	autoResizePrompt();
	hideSlashAutocomplete();
	setStatus("", false);
	logWebview("Running slash command", { command: command.command, source: command.source });
	vscode.postMessage({ type: "slashCommand", commandName: command.name, commandText: trimmed });
	return true;
}

function updateSlashAutocomplete() {
	const value = prompt.value.trimStart();
	if (value.startsWith("/") && !/\s/.test(value)) {
		autocompleteMode = "slash";
		slashSuggestions = slashCommands.filter((candidate) => candidate.command.startsWith(value));
		if (!slashSuggestions.length) {
			hideSlashAutocomplete();
			return;
		}
		activeSlashSuggestionIndex = Math.min(activeSlashSuggestionIndex, slashSuggestions.length - 1);
		renderSlashAutocomplete();
		return;
	}

	const pathToken = getActivePathToken();
	if (pathToken) {
		autocompleteMode = "path";
		latestPathAutocompleteRequestId = ++pathAutocompleteRequestId;
		vscode.postMessage({ type: "pathAutocomplete", requestId: latestPathAutocompleteRequestId, query: pathToken.query });
		return;
	}

	hideSlashAutocomplete();
}

function getActivePathToken() {
	const cursor = prompt.selectionStart;
	const beforeCursor = prompt.value.slice(0, cursor);
	const match = beforeCursor.match(/(^|\s)@([^\s]*)$/);
	if (!match) {
		return undefined;
	}
	return { start: match.index + match[1].length, end: cursor, query: match[2] };
}

function setPathSuggestions(requestId, suggestions) {
	if (requestId !== latestPathAutocompleteRequestId || autocompleteMode !== "path" || !getActivePathToken()) {
		return;
	}
	slashSuggestions = suggestions.map((suggestion) => ({
		command: "@" + suggestion.path,
		description: "",
		path: suggestion.path,
		isDirectory: Boolean(suggestion.isDirectory),
	}));
	if (!slashSuggestions.length) {
		hideSlashAutocomplete();
		return;
	}
	activeSlashSuggestionIndex = Math.min(activeSlashSuggestionIndex, slashSuggestions.length - 1);
	renderSlashAutocomplete();
}

function renderSlashAutocomplete() {
	slashAutocomplete.textContent = "";
	if (!slashSuggestions.length) {
		hideSlashAutocomplete();
		return;
	}
	for (const [index, suggestion] of slashSuggestions.entries()) {
		const option = document.createElement("button");
		option.type = "button";
		option.className = "slash-autocomplete-option";
		option.id = "slash-autocomplete-option-" + index;
		option.setAttribute("role", "option");
		option.setAttribute("aria-selected", String(index === activeSlashSuggestionIndex));
		if (index === activeSlashSuggestionIndex) {
			option.classList.add("active");
			prompt.setAttribute("aria-activedescendant", option.id);
		}
		const command = document.createElement("span");
		command.className = "slash-autocomplete-command";
		command.textContent = suggestion.command;
		option.append(command);
		if (suggestion.description) {
			const description = document.createElement("span");
			description.className = "slash-autocomplete-description";
			description.textContent = suggestion.description;
			option.append(description);
		}
		option.addEventListener("mousedown", (event) => {
			event.preventDefault();
			selectSlashSuggestion(index);
		});
		slashAutocomplete.append(option);
	}
	slashAutocomplete.classList.remove("hidden");
	scrollActiveSlashSuggestionIntoView();
}

function scrollActiveSlashSuggestionIntoView() {
	const activeOption = slashAutocomplete.querySelector(".slash-autocomplete-option.active");
	if (!activeOption) {
		return;
	}
	const optionTop = activeOption.offsetTop;
	const optionBottom = optionTop + activeOption.offsetHeight;
	const visibleTop = slashAutocomplete.scrollTop;
	const visibleBottom = visibleTop + slashAutocomplete.clientHeight;
	if (optionTop < visibleTop) {
		slashAutocomplete.scrollTop = optionTop;
	}
	if (optionBottom > visibleBottom) {
		slashAutocomplete.scrollTop = optionBottom - slashAutocomplete.clientHeight;
	}
}

function hideSlashAutocomplete() {
	slashSuggestions = [];
	activeSlashSuggestionIndex = 0;
	autocompleteMode = "";
	slashAutocomplete.classList.add("hidden");
	slashAutocomplete.textContent = "";
	prompt.removeAttribute("aria-activedescendant");
}

function handleSlashAutocompleteKeydown(event) {
	if (slashAutocomplete.classList.contains("hidden")) {
		return false;
	}
	if (event.key === "ArrowDown") {
		event.preventDefault();
		activeSlashSuggestionIndex = (activeSlashSuggestionIndex + 1) % slashSuggestions.length;
		renderSlashAutocomplete();
		return true;
	}
	if (event.key === "ArrowUp") {
		event.preventDefault();
		activeSlashSuggestionIndex = (activeSlashSuggestionIndex - 1 + slashSuggestions.length) % slashSuggestions.length;
		renderSlashAutocomplete();
		return true;
	}
	if (event.key === "Tab" || (autocompleteMode === "slash" && event.key === "Enter" && prompt.value.trim() !== slashSuggestions[activeSlashSuggestionIndex]?.command)) {
		event.preventDefault();
		selectSlashSuggestion(activeSlashSuggestionIndex);
		return true;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		hideSlashAutocomplete();
		return true;
	}
	return false;
}

function selectSlashSuggestion(index) {
	const suggestion = slashSuggestions[index];
	if (!suggestion) {
		return;
	}
	if (autocompleteMode === "path") {
		const token = getActivePathToken();
		if (!token) {
			hideSlashAutocomplete();
			return;
		}
		prompt.value = prompt.value.slice(0, token.start) + suggestion.command + prompt.value.slice(token.end);
		const cursor = token.start + suggestion.command.length;
		prompt.setSelectionRange(cursor, cursor);
		autoResizePrompt();
		if (suggestion.isDirectory) {
			updateSlashAutocomplete();
		} else {
			hideSlashAutocomplete();
		}
		prompt.focus();
		return;
	}
	prompt.value = suggestion.command;
	autoResizePrompt();
	hideSlashAutocomplete();
	prompt.focus();
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

function setRandomEmptyStateFlavorText() {
	if (!emptyStateText || emptyStateFlavorTexts.length === 0) {
		return;
	}
	emptyStateText.textContent = emptyStateFlavorTexts[Math.floor(Math.random() * emptyStateFlavorTexts.length)];
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
