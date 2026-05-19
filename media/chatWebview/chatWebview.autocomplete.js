function setSlashCommands(commands) {
	slashCommands = commands
		.filter((command) => typeof command?.name === "string" && command.name.trim())
		.map((command) => ({
			name: command.name,
			command: "/" + command.name,
			description: command.description || (command.disabled === true ? "not supported yet" : formatSlashCommandSource(command)),
			disabled: command.disabled === true,
			source: command.source,
		}));
	logWebview("Slash commands updated", { count: slashCommands.length, commands: slashCommands.slice(0, 20).map((command) => command.command) });
	updateSlashAutocomplete(false);
}

function formatSlashCommandSource(command) {
	const sourceInfo = command.sourceInfo && typeof command.sourceInfo === "object" ? command.sourceInfo : undefined;
	const location = command.location || sourceInfo?.scope;
	const path = command.path || sourceInfo?.path;
	const parts = [command.source, location, path].filter((part) => typeof part === "string" && part);
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
	if (command.disabled) {
		setStatus(command.command + " is not supported yet", true);
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

function updateSlashAutocomplete(requestRefresh = true) {
	const value = prompt.value.trimStart();
	if (value.startsWith("/") && !/\s/.test(value)) {
		autocompleteMode = "slash";
		if (requestRefresh) {
			requestSlashCommandsRefresh();
		}
		slashSuggestions = getSlashCommandSuggestions(value);
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

function requestSlashCommandsRefresh() {
	window.clearTimeout(slashCommandRefreshTimer);
	slashCommandRefreshTimer = window.setTimeout(() => {
		vscode.postMessage({ type: "refreshSlashCommands" });
	}, 300);
}

function getSlashCommandSuggestions(value) {
	const query = value.replace(/^\/+/, "").toLowerCase();
	return slashCommands
		.map((candidate) => ({ ...candidate, score: getSlashCommandScore(candidate, query) }))
		.filter((candidate) => candidate.score !== undefined)
		.sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) || a.score - b.score || a.command.length - b.command.length || a.command.localeCompare(b.command));
}

function getSlashCommandScore(candidate, query) {
	if (!query) {
		return 0;
	}
	const searchable = [candidate.name, candidate.command, candidate.name.split(":").pop() || ""].filter(Boolean);
	let bestScore;
	for (const value of searchable) {
		const score = getFuzzyScore(value.toLowerCase(), query);
		if (score !== undefined && (bestScore === undefined || score < bestScore)) {
			bestScore = score;
		}
	}
	return bestScore;
}

function getFuzzyScore(value, query) {
	if (value === query) {
		return 0;
	}
	if (value.startsWith(query)) {
		return 10 + value.length / 1000;
	}
	const substringIndex = value.indexOf(query);
	if (substringIndex !== -1) {
		return 100 + substringIndex * 10 + value.length / 1000;
	}
	let queryIndex = 0;
	let score = 1000;
	for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex++) {
		if (value[valueIndex] === query[queryIndex]) {
			score += valueIndex;
			queryIndex++;
		}
	}
	return queryIndex === query.length ? score + value.length / 1000 : undefined;
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
		if (suggestion.disabled) {
			option.classList.add("disabled");
			option.disabled = true;
			option.setAttribute("aria-disabled", "true");
		}
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
	if (event.key === "Tab" || (event.key === "Enter" && (autocompleteMode === "path" || (autocompleteMode === "slash" && prompt.value.trim() !== slashSuggestions[activeSlashSuggestionIndex]?.command)))) {
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
	if (suggestion.disabled) {
		setStatus(suggestion.command + " is not supported yet", true);
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
