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

function isAtTop() {
	return messages.scrollTop <= 2;
}

function isAtBottom() {
	return messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 2;
}

function updateConversationNavButtons() {
	const atTop = isAtTop();
	const atBottom = isAtBottom();

	jumpTop.disabled = atTop;
	jumpPreviousUser.disabled = atTop;
	jumpNextUser.disabled = atBottom;
}

function setFollowChatEnabled(enabled) {
	followChatEnabled = Boolean(enabled);
	followChat.classList.toggle("active", followChatEnabled);
	followChat.setAttribute("aria-pressed", String(followChatEnabled));
}

function waitForProgrammaticScrollToBottom(token) {
	const startedAt = Date.now();
	const timeoutMs = 1000;
	const finish = () => {
		if (token !== programmaticScrollToken) {
			return;
		}
		if (isAtBottom()) {
			programmaticScrollToBottom = false;
			setFollowChatEnabled(true);
			updateConversationNavButtons();
			return;
		}
		if (Date.now() - startedAt >= timeoutMs) {
			programmaticScrollToBottom = false;
			updateConversationNavButtons();
			return;
		}
		window.requestAnimationFrame(finish);
	};
	window.requestAnimationFrame(finish);
}

function handleMessagesScroll() {
	updateConversationNavButtons();

	if (programmaticScrollToBottom) {
		return;
	}
	if (isAtBottom()) {
		setFollowChatEnabled(true);
	} else {
		setFollowChatEnabled(false);
	}
}

function handleManualScrollUp() {
	programmaticScrollToken += 1;
	programmaticScrollToBottom = false;
	setFollowChatEnabled(false);
}

function keepLoadingAtBottom() {
	const loading = messagesContent.querySelector(".message.loading");
	if (!loading) {
		return;
	}
	const targetParent = currentTurn ?? loading.parentElement;
	if (targetParent && (loading.parentElement !== targetParent || loading !== targetParent.lastElementChild)) {
		targetParent.append(loading);
	}
}

function finishContentUpdate() {
	if (followChatEnabled) {
		scrollToBottom();
	}
}

function scrollMessagesTo(top, smooth) {
	messages.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
	updateConversationNavButtons();
}

function scrollToBottom(smooth = false) {
	programmaticScrollToBottom = true;
	programmaticScrollToken += 1;
	const token = programmaticScrollToken;
	setFollowChatEnabled(true);
	scrollMessagesTo(messages.scrollHeight, smooth);
	waitForProgrammaticScrollToBottom(token);
}
