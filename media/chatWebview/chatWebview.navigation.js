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
