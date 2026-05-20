const vscode = acquireVsCodeApi();
let persistedWebviewState = vscode.getState() || {};
function updatePersistedWebviewState(update) {
	persistedWebviewState = Object.assign({}, persistedWebviewState, update);
	vscode.setState(persistedWebviewState);
}
const sessionTitle = document.getElementById("session-title");
const messages = document.getElementById("messages");
const messagesContent = document.getElementById("messages-content");
const emptyState = document.getElementById("empty-state");
const emptyStateText = document.getElementById("empty-state-text");
const form = document.getElementById("form");
const prompt = document.getElementById("prompt");
const submit = document.getElementById("submit");
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
let includeIdeContextByDefault = window.crustInitialSettings?.includeIdeContextByDefault === true;
let ideContextEnabled = includeIdeContextByDefault;
let currentIdeContextLabel = "";
let currentTurn = null;
let piProcessing = false;
let slashCommands = [];
let slashSuggestions = [];
let activeSlashSuggestionIndex = 0;
let autocompleteMode = "";
let pathAutocompleteRequestId = 0;
let latestPathAutocompleteRequestId = 0;
let slashCommandRefreshTimer = 0;
let promptHistory = Array.isArray(persistedWebviewState.promptHistory) ? persistedWebviewState.promptHistory.filter((entry) => typeof entry === "string" && entry.trim()) : [];
let promptHistoryCursor = promptHistory.length;
let promptHistoryDraft = "";
let restoringPromptHistory = false;
let projectFileReferences = new Set();
let existingFileReferences = new Set();
let missingFileReferences = new Set();
let projectRoots = [];
let pendingFileReferenceValidation = new Set();
let fileReferenceValidationTimer = 0;
let fileReferenceValidationRequestId = 0;

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

