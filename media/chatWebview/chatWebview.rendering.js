function setSessionTitle(title) {
	sessionTitle.textContent = title;
	sessionTitle.title = title;
	updatePersistedWebviewState({ sessionTitle: title });
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

function addMessage(id, role, text, loading, ideContextLabel, slashCommandLabel, secondary, error, compaction) {
	const element = document.createElement("div");
	element.id = id;
	element.className = "message " + role + (loading ? " loading" : "") + (secondary ? " secondary" : "") + (error ? " error-message" : "") + (compaction ? " compaction-message" : "");
	if (role === "assistant" && compaction && !loading) {
		renderCompactionMessage(element, text);
	} else if (role === "assistant" && !loading) {
		setMarkdownContent(element, text);
	} else if (role === "user") {
		renderUserMessage(element, text, ideContextLabel, slashCommandLabel);
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

function renderCompactionMessage(element, text) {
	const fullText = text.trim();
	const previewText = getCompactionPreviewText(fullText);
	const body = document.createElement("div");
	body.className = "compaction-body";
	setMarkdownContent(body, previewText || fullText);
	element.append(body);

	if (!previewText || previewText === fullText) {
		return;
	}

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "compaction-toggle";
	toggle.textContent = "Show full compaction";
	toggle.setAttribute("aria-expanded", "false");
	toggle.addEventListener("click", () => {
		const expanded = element.classList.toggle("expanded");
		toggle.textContent = expanded ? "Show less" : "Show full compaction";
		toggle.setAttribute("aria-expanded", String(expanded));
		setMarkdownContent(body, expanded ? fullText : previewText);
		finishContentUpdate();
	});
	element.append(toggle);
}

function getCompactionPreviewText(markdown) {
	return markdown.replace(/\r\n/g, "\n").split("\n", 1)[0].trim();
}

function renderUserMessage(element, text, ideContextLabel, slashCommandLabel) {
	if (ideContextLabel) {
		appendMessageContext(element, ideContextLabel, ideContextLabel, createEyeIcon());
	}
	if (slashCommandLabel) {
		const contextTitle = slashCommandLabel.startsWith("/skill:") ? "Skill: " + slashCommandLabel.slice(7) : "Slash command: " + slashCommandLabel;
		appendMessageContext(element, slashCommandLabel, contextTitle);
	}

	if (text) {
		const body = document.createElement("div");
		body.className = "user-message-body";
		setMarkdownContent(body, text);
		element.append(body);
	}

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

function appendMessageContext(element, text, title, icon) {
	const context = document.createElement("div");
	context.className = "message-context";
	context.title = title;
	if (icon) {
		context.append(icon);
	}
	const label = document.createElement("span");
	appendProjectFileLinkedText(label, text);
	context.append(label);
	element.append(context);
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

function appendMessage(id, text, error) {
	const element = document.getElementById(id);
	if (!element) {
		return;
	}
	element.classList.remove("loading");
	if (error) {
		element.classList.add("error-message");
	}
	if (element.classList.contains("assistant")) {
		setMarkdownContent(element, (element.dataset.markdown ?? "") + text);
	} else if (element.classList.contains("user")) {
		const body = element.querySelector(".user-message-body");
		if (body) {
			setMarkdownContent(body, (body.dataset.markdown ?? "") + text);
			initUserMessageToggle(element);
		}
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

function setMarkdownSettings(settings) {
	if (window.crustMarkdown && typeof window.crustMarkdown.setAllowRawHtml === "function") {
		window.crustMarkdown.setAllowRawHtml(settings.allowRawHtml === true);
	}
	for (const element of Array.from(document.querySelectorAll("[data-markdown]"))) {
		renderMarkdown(element, element.dataset.markdown ?? "");
	}
}

function setChatSettings(settings) {
	includeIdeContextByDefault = settings.includeIdeContextByDefault === true;
	if (!currentIdeContextLabel) {
		ideContextEnabled = includeIdeContextByDefault;
		updateIdeContextButtonState();
	}
}

function renderMarkdown(element, markdown) {
	element.textContent = "";
	if (!window.crustMarkdown || typeof window.crustMarkdown.render !== "function") {
		renderPlainMarkdownFallback(element, markdown);
		return;
	}

	element.innerHTML = window.crustMarkdown.render(markdown);
	enhanceRenderedMarkdown(element);
}

function renderPlainMarkdownFallback(element, markdown) {
	const pre = document.createElement("pre");
	pre.textContent = markdown;
	element.append(pre);
}

function enhanceRenderedMarkdown(element) {
	enhanceTaskListItems(element);
	wrapCodeBlocks(element);
	wrapTables(element);
	hardenLinks(element);
	convertRenderedFileReferenceLinks(element);
	linkifyProjectFileReferences(element);
}

function enhanceTaskListItems(element) {
	for (const item of Array.from(element.querySelectorAll("li"))) {
		const target = getTaskListMarkerTarget(item);
		const marker = target?.textContent?.match(/^\[( |x|X)\]\s*/);
		if (!target || !marker) {
			continue;
		}

		target.textContent = target.textContent.slice(marker[0].length);
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = marker[1].toLowerCase() === "x";
		checkbox.disabled = true;
		checkbox.className = "markdown-task-checkbox";
		checkbox.setAttribute("aria-label", checkbox.checked ? "Completed task" : "Incomplete task");
		item.classList.add("markdown-task-list-item");
		item.prepend(checkbox, document.createTextNode(" "));
	}
}

function getTaskListMarkerTarget(item) {
	if (item.firstChild?.nodeType === Node.TEXT_NODE) {
		return item.firstChild;
	}
	const firstElement = item.firstElementChild;
	if (firstElement?.tagName === "P" && firstElement.firstChild?.nodeType === Node.TEXT_NODE) {
		return firstElement.firstChild;
	}
	return undefined;
}

function wrapCodeBlocks(element) {
	for (const code of Array.from(element.querySelectorAll("pre > code"))) {
		const pre = code.parentElement;
		if (!pre || pre.parentElement?.classList.contains("markdown-code-block")) {
			continue;
		}

		const wrapper = document.createElement("div");
		wrapper.className = "markdown-code-block";
		pre.replaceWith(wrapper);
		wrapper.append(pre);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "markdown-code-copy";
		button.setAttribute("aria-label", "Copy code block");
		button.title = "Copy code";
		button.append(createCopyIcon());
		button.addEventListener("click", async () => {
			const copied = await copyTextToClipboard(code.textContent ?? "");
			button.classList.toggle("copied", copied);
			button.setAttribute("aria-label", copied ? "Copied code block" : "Copy code block");
			button.title = copied ? "Copied" : "Copy code";
			window.setTimeout(() => {
				button.classList.remove("copied");
				button.setAttribute("aria-label", "Copy code block");
				button.title = "Copy code";
			}, 1400);
		});
		wrapper.append(button);
	}
}

function wrapTables(element) {
	for (const table of Array.from(element.querySelectorAll("table"))) {
		if (table.parentElement?.classList.contains("markdown-table-wrapper")) {
			continue;
		}

		const wrapper = document.createElement("div");
		wrapper.className = "markdown-table-wrapper";
		table.replaceWith(wrapper);
		wrapper.append(table);
	}
}

function hardenLinks(element) {
	for (const link of Array.from(element.querySelectorAll("a[href]"))) {
		const href = link.getAttribute("href") ?? "";
		if (!isSafeMarkdownUrl(href)) {
			link.removeAttribute("href");
			continue;
		}

		link.setAttribute("rel", "noreferrer noopener");
		link.setAttribute("target", "_blank");
	}
}

function isSafeMarkdownUrl(href) {
	try {
		const url = new URL(href, "https://crust.local");
		return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
	} catch (_error) {
		return false;
	}
}

async function copyTextToClipboard(text) {
	if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (_error) {
			// Fall back to a temporary textarea for webview environments without Clipboard API access.
		}
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	try {
		return document.execCommand("copy");
	} finally {
		textarea.remove();
	}
}

function createCopyIcon() {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("width", "14");
	svg.setAttribute("height", "14");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("fill", "none");

	const back = document.createElementNS("http://www.w3.org/2000/svg", "path");
	back.setAttribute("d", "M5.25 4.25V3.5C5.25 2.95 5.7 2.5 6.25 2.5H11.5C12.05 2.5 12.5 2.95 12.5 3.5V8.75C12.5 9.3 12.05 9.75 11.5 9.75H10.75");
	back.setAttribute("stroke", "currentColor");
	back.setAttribute("stroke-width", "1.2");
	back.setAttribute("stroke-linejoin", "round");
	svg.append(back);

	const front = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	front.setAttribute("x", "3.5");
	front.setAttribute("y", "5.25");
	front.setAttribute("width", "7.25");
	front.setAttribute("height", "7.25");
	front.setAttribute("rx", "1");
	front.setAttribute("stroke", "currentColor");
	front.setAttribute("stroke-width", "1.2");
	svg.append(front);
	return svg;
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

		const bodyWrapper = document.createElement("div");
		bodyWrapper.className = "tool-body-wrapper";
		element.append(bodyWrapper);

		const body = document.createElement("pre");
		body.className = "tool-body";
		bodyWrapper.append(body);
		bodyWrapper.append(createToolOutputCopyButton(body));
		appendConversationElement(element, false);
		updateEmptyState();
	}

	const hasBody = Boolean(message.body);
	element.className = "tool-card " + (message.status ?? "");
	element.classList.toggle("no-body", !hasBody);
	const header = element.querySelector(".tool-header");
	const bodyWrapper = element.querySelector(".tool-body-wrapper");
	const body = element.querySelector(".tool-body");
	const path = message.path ? " " + message.path : "";
	const headerText = (message.toolName ?? "tool") + path + formatToolStatus(message.status);
	header.textContent = "";
	const toolName = document.createElement("span");
	toolName.className = "tool-name";
	toolName.textContent = message.toolName ?? "tool";
	header.append(toolName);
	appendProjectFileLinkedText(header, path + formatToolStatus(message.status));
	header.title = headerText;
	renderToolBody(body, message.body ?? "", Boolean(message.isDiff),);
	bodyWrapper.hidden = !hasBody;
	body.classList.toggle("diff", Boolean(message.isDiff));
	keepLoadingAtBottom();
	finishContentUpdate();
}

function createToolOutputCopyButton(body) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "markdown-code-copy tool-body-copy";
	button.setAttribute("aria-label", "Copy tool output");
	button.title = "Copy tool output";
	button.append(createCopyIcon());
	button.addEventListener("click", async () => {
		const copied = await copyTextToClipboard(body.textContent ?? "");
		button.classList.toggle("copied", copied);
		button.setAttribute("aria-label", copied ? "Copied tool output" : "Copy tool output");
		button.title = copied ? "Copied" : "Copy tool output";
		window.setTimeout(() => {
			button.classList.remove("copied");
			button.setAttribute("aria-label", "Copy tool output");
			button.title = "Copy tool output";
		}, 1400);
	});
	return button;
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

const PROJECT_FILE_REFERENCE_PATTERN = /(^|[^A-Za-z0-9@:/._-])(@?(?:(?:\/|~\/)(?:[A-Za-z0-9._@%+=,;~()-]+\/)+[A-Za-z0-9._@%+=,;~()-]+|(?:\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)+(?:[A-Za-z0-9._@%+=,;~() -]+\.[A-Za-z0-9]{1,8}|\.[A-Za-z0-9][A-Za-z0-9._-]*)|[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}|\.[A-Za-z0-9][A-Za-z0-9._-]*)(?:[:#](?:L)?\d+(?::\d+)?)?)(?![A-Za-z0-9._/-])/g;
const PROJECT_FILE_TRAILING_PUNCTUATION = /[),.;!?]+$/;

function setProjectFiles(files, roots) {
	projectFileReferences = new Set(files.filter((file) => typeof file === "string" && file).map(normalizeProjectFilePath));
	projectRoots = roots.filter((root) => typeof root === "string" && root).map(normalizeProjectFilePath).map((root) => root.replace(/\/$/, ""));
	rerenderFileReferenceContent();
}

function setValidatedFileReferences(references, missing) {
	let changed = false;
	for (const reference of references) {
		if (typeof reference !== "string") {
			continue;
		}
		const key = normalizeFileReferenceKey(reference);
		if (!existingFileReferences.has(key)) {
			existingFileReferences.add(key);
			missingFileReferences.delete(key);
			changed = true;
		}
	}
	for (const reference of missing) {
		if (typeof reference !== "string") {
			continue;
		}
		const key = normalizeFileReferenceKey(reference);
		if (key) {
			missingFileReferences.add(key);
		}
	}
	if (changed) {
		rerenderFileReferenceContent();
	}
}

function rerenderFileReferenceContent() {
	for (const element of Array.from(document.querySelectorAll("[data-markdown]"))) {
		renderMarkdown(element, element.dataset.markdown ?? "");
	}
	for (const element of Array.from(document.querySelectorAll(".message-context span, .tool-header"))) {
		linkifyProjectFileReferences(element);
	}
}

function convertRenderedFileReferenceLinks(element) {
	for (const link of Array.from(element.querySelectorAll("a[href]"))) {
		const reference = link.textContent?.trim() ?? "";
		if (!reference || !isExistingFileReference(reference)) {
			queueFileReferenceValidation(reference);
			continue;
		}
		link.replaceWith(createProjectFileLink(reference));
	}
}

function linkifyProjectFileReferences(element) {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || parent.closest("a, button, textarea, select")) {
				return NodeFilter.FILTER_REJECT;
			}
			PROJECT_FILE_REFERENCE_PATTERN.lastIndex = 0;
			return PROJECT_FILE_REFERENCE_PATTERN.test(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	const textNodes = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode);
	}
	for (const node of textNodes) {
		const fragment = document.createDocumentFragment();
		appendProjectFileLinkedText(fragment, node.textContent ?? "");
		node.replaceWith(fragment);
	}
}

function appendProjectFileLinkedText(parent, text) {
	PROJECT_FILE_REFERENCE_PATTERN.lastIndex = 0;
	let lastIndex = 0;
	let match;
	while ((match = PROJECT_FILE_REFERENCE_PATTERN.exec(text)) !== null) {
		const prefix = match[1] ?? "";
		const rawReference = match[2] ?? "";
		const referenceStart = match.index + prefix.length;
		let reference = rawReference;
		const trailing = reference.match(PROJECT_FILE_TRAILING_PUNCTUATION)?.[0] ?? "";
		if (trailing) {
			reference = reference.slice(0, -trailing.length);
		}
		if (!reference || !isExistingFileReference(reference)) {
			queueFileReferenceValidation(reference);
			continue;
		}
		parent.append(document.createTextNode(text.slice(lastIndex, referenceStart)));
		parent.append(createProjectFileLink(reference));
		lastIndex = referenceStart + reference.length;
	}
	parent.append(document.createTextNode(text.slice(lastIndex)));
}

function isExistingFileReference(reference) {
	return Boolean(getProjectFileReferencePath(reference)) || existingFileReferences.has(normalizeFileReferenceKey(reference));
}

function getProjectFileReferencePath(reference) {
	let value = normalizeFileReferenceKey(reference);
	if (!value) {
		return "";
	}
	value = value.replace(/^\.\//, "");
	if (projectFileReferences.has(value)) {
		return value;
	}
	for (const root of projectRoots) {
		const prefix = root + "/";
		if (value.startsWith(prefix)) {
			const relative = value.slice(prefix.length);
			return projectFileReferences.has(relative) ? relative : "";
		}
	}
	return "";
}

function normalizeFileReferenceKey(reference) {
	let value = normalizeProjectFilePath(reference).replace(/^@/, "").replace(/^`|`$/g, "");
	value = value.replace(/^["'<({[]+|["'>)}\],.;!?]+$/g, "");
	value = value.replace(/(?:[:#]L?)\d+(?::\d+)?$/i, "");
	return !value || /^[a-z][a-z0-9+.-]*:/i.test(value) ? "" : value;
}

function queueFileReferenceValidation(reference) {
	const key = normalizeFileReferenceKey(reference);
	if (!key || pendingFileReferenceValidation.has(reference) || existingFileReferences.has(key) || missingFileReferences.has(key)) {
		return;
	}
	pendingFileReferenceValidation.add(reference);
	window.clearTimeout(fileReferenceValidationTimer);
	fileReferenceValidationTimer = window.setTimeout(() => {
		const references = [...pendingFileReferenceValidation];
		pendingFileReferenceValidation.clear();
		vscode.postMessage({ type: "validateFileReferences", requestId: ++fileReferenceValidationRequestId, references });
	}, 50);
}

function normalizeProjectFilePath(path) {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function createProjectFileLink(reference) {
	const link = document.createElement("a");
	link.href = "#";
	link.className = "project-file-link";
	link.dataset.projectFile = reference;
	link.textContent = reference;
	link.title = "Open " + reference;
	link.addEventListener("click", (event) => {
		event.preventDefault();
		vscode.postMessage({ type: "openProjectFile", path: reference });
	});
	return link;
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
		ideContextEnabled = includeIdeContextByDefault;
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
