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
