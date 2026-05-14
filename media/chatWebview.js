const vscode = acquireVsCodeApi();
const sessionTitle = document.getElementById("session-title");
const messages = document.getElementById("messages");
const form = document.getElementById("form");
const prompt = document.getElementById("prompt");
const model = document.getElementById("model");
const status = document.getElementById("status");
const history = document.getElementById("history");

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = prompt.value;
	if (!text.trim()) {
		return;
	}
	prompt.value = "";
	autoResizePrompt();
	vscode.postMessage({ type: "submit", text });
});

prompt.addEventListener("input", autoResizePrompt);

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

window.addEventListener("message", (event) => {
	const message = event.data;
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
	if (message.type === "clearMessages") {
		messages.textContent = "";
	}
	if (message.type === "addMessage") {
		addMessage(message.id, message.role, message.text ?? "", message.loading ?? false);
	}
	if (message.type === "appendMessage") {
		appendMessage(message.id, message.text ?? "");
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

function addMessage(id, role, text, loading) {
	const element = document.createElement("div");
	element.id = id;
	element.className = "message " + role + (loading ? " loading" : "");
	element.textContent = text;
	messages.append(element);
	scrollToBottom();
}

function appendMessage(id, text) {
	const element = document.getElementById(id);
	if (!element) {
		return;
	}
	element.classList.remove("loading");
	element.textContent += text;
	scrollToBottom();
}

function addThinking(id) {
	const element = document.createElement("section");
	element.id = id;
	element.className = "thinking-card";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "thinking-toggle";
	button.textContent = "Show thinking";
	button.addEventListener("click", () => {
		const expanded = element.classList.toggle("expanded");
		button.textContent = expanded ? "Hide thinking" : "Show thinking";
	});
	element.append(button);

	const body = document.createElement("pre");
	body.className = "thinking-body";
	element.append(body);
	messages.append(element);
	scrollToBottom();
}

function appendThinking(id, text) {
	const body = document.querySelector("#" + CSS.escape(id) + " .thinking-body");
	if (!body) {
		return;
	}
	body.textContent += text;
	scrollToBottom();
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
		messages.append(element);
	}

	element.className = "tool-card " + (message.status ?? "");
	const header = element.querySelector(".tool-header");
	const body = element.querySelector(".tool-body");
	const path = message.path ? " " + message.path : "";
	header.textContent = (message.toolName ?? "tool") + path + formatToolStatus(message.status);
	header.title = header.textContent;
	body.textContent = message.body ?? "";
	body.hidden = !message.body;
	body.classList.toggle("diff", Boolean(message.isDiff));
	scrollToBottom();
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

function autoResizePrompt() {
	prompt.style.height = "28px";
	prompt.style.height = Math.max(28, Math.min(prompt.scrollHeight, 180)) + "px";
	prompt.style.overflowY = prompt.scrollHeight > 180 ? "auto" : "hidden";
}

function scrollToBottom() {
	messages.scrollTop = messages.scrollHeight;
}
