# AGENTS.md

Guidance for coding agents working in this repository.

## Project context

Crust is a Visual Studio Code extension that provides a VS Code chat UI for the [Pi Coding Agent](https://pi.dev/). The goal remains feature parity with comparable coding-agent extensions, including session browsing, IDE context integration, slash/file autocomplete, rich rendering, and diff viewing.

The project has a real implementation rather than only VS Code template code. The extension contributes `crust.openChat`, `crust.openChatTerminal`, `crust.openChatDefault`, session explorer commands, a Crust activity-bar session view, and editor title/keybinding entry points. It opens locked side-by-side chat webviews by default, can optionally open Pi's native TUI in a terminal editor tab, starts Pi with `pi --mode rpc` for webview chats, streams assistant responses/thinking/tool activity, supports model selection and usage/status display, can browse/restore previous Pi JSONL sessions, starts new chats, runs supported slash commands (including `/compact`, `/clone`, `/export`, `/session`, `/changelog`, emulated `/reload`, and `/quit`), and can attach current editor file/selection context to prompts. Multiple Crust webview and terminal instances can coexist and restored tabs/sessions are serialized with their session paths.

## Current architecture

- `src/extension.ts` contains extension activation and command registration only.
- `src/pi/piRpcClient.ts` owns the Pi RPC child process, JSONL request/response handling, event forwarding, supported RPC commands (`prompt`, `steer`, abort, model/session changes, compact, clone, HTML export, slash command discovery), and RPC logging.
- `src/pi/rpcTypes.ts` contains lightweight runtime guards and shared Pi RPC types, including typed tool result/event shapes.
- `src/ui/chatPanel.ts` coordinates each VS Code webview panel, Pi RPC client, session restore/new chat, model/status/usage updates, IDE context injection, slash commands, manual compaction/export/reload/session flows, `@` path autocomplete, task cancellation/steering, tool cards/diffs, project file opening/link validation, settings refresh, and targeted model-connection error notifications.
- `src/ui/terminalView.ts` implements the opt-in terminal editor mode (`crust.chat.useTerminalViewByDefault`) that opens Pi's native TUI in a VS Code terminal tab, restores terminal sessions after reloads, tracks open terminal session paths, and maintains a small IDE-context JSON file plus a local bridge for the bundled Pi extension in `resources/pi/`.
- `src/ui/sessionExplorer.ts` implements the Crust activity-bar session browser webview, including refresh/new/open commands, debounced visible-only filesystem refreshes, incremental webview content updates to avoid flicker, open-session highlighting across webview and terminal sessions, quick-pick restore, and default routing to the webview or terminal experience.
- `src/ui/streamingEventRenderer.ts`, `sessionRestoreRenderer.ts`, `conversationState.ts`, `slashCommands.ts`, and `chatPanelUtils.ts` contain the split-out rendering, session replay, conversation state, slash command, and panel utility logic that keeps `chatPanel.ts` focused.
- `src/ui/chatTypes.ts`, `ideContext.ts`, `messageUtils.ts`, `pathAutocomplete.ts`, `sessionHistory.ts`, `toolUtils.ts`, and `usageStatus.ts` hold focused UI-side parsing, formatting, session, filesystem, and tool helpers.
- `src/ui/chatWebview.ts` loads the static webview template, reads contributed chat/markdown settings, and injects CSP nonce/resource URIs.
- `src/utils/crustLogger.ts`, `errorMessage.ts`, and `nonce.ts` provide output-channel logging, error stringification, and CSP nonce generation.
- `src/webview/markdownRenderer.ts` builds the vendored `markdown-it` webview bundle used for rich Markdown rendering.
- `media/chatWebview.html` and the plain CSS/JavaScript files under `media/chatWebview/` implement the webview UI. The webview scripts are syntax-checked separately; they handle markdown-it rendering, optional sanitized raw HTML, expandable compaction summaries, copyable code/tool-output blocks, project file links (including Markdown-rendered file-reference links), inline diff rendering, slash and path autocomplete, IDE context toggling, persisted webview state, prompt history recall, cancellation shortcuts, empty states, conversation navigation, and logging back to the extension.
- `branding/` contains extension and webview icons.
- `src/test/extension.test.ts` contains the VS Code integration/unit test suite for RPC guards/client behavior, slash command fallbacks and emulated commands, webview message validation, chat panel helpers, streaming rendering, session restore rendering (including compaction summaries), IDE context, tool utilities, usage formatting, path autocomplete, session history/session explorer integration (including anti-flicker refresh behavior), terminal-view wiring, settings, and static webview behavior.
- `.github/workflows/ci.yml` runs CI validation; `.github/dependabot.yml` manages dependency update PRs.

## Working guidelines

- Treat `README.md` as the source of truth for current project goals and status, but keep this file updated when architecture or workflow changes.
- Prefer small, focused changes with clear separation between extension activation, Pi integration, UI/webview code, and VS Code command registration.
- Keep user-facing behavior aligned with VS Code extension conventions.
- Assume Pi must be installed and available on `PATH`, as documented in `README.md`; some features also shell out to `git` or inspect the installed Pi CLI for built-in slash command metadata.
- Avoid introducing framework complexity for the webview unless there is a clear need; the current webview assets are static files under `media/`, with only the small markdown-it bundle generated by the existing esbuild workflow.
- Preserve the RPC/webview boundary: extension code should talk to Pi, the filesystem, Git, and VS Code APIs, while the webview should handle DOM rendering and post typed messages back to the extension.
- Keep restored sessions compatible with Pi JSONL history, including Crust's `<ide_context>` prompt wrapper, Pi skill wrapper stripping/display logic, and Crust's persisted webview state.

## Development commands

Use the scripts defined in `package.json` for validation and builds. Common checks include:

```sh
npm run compile
npm test
npm run lint
npm run check-webview
```

`npm run compile` runs type checking, linting, webview syntax checking, and the esbuild bundle. `npm test` compiles tests and runs the suite against both the minimum supported VS Code (`1.74.0`) and the current VS Code. `npm run package` performs the production build used by `vscode:prepublish`.

## Notes

- Avoid adding large generated artifacts unless they are required by the extension packaging workflow; `media/chatWebview/generated/markdown-it.bundle.js` is intentionally generated and packaged.
- Keep documentation updated as features move beyond the current implementation.
- Logs are available in the `Crust` and `Crust Pi RPC` output channels when debugging extension/Pi behavior.
- Keep model/provider error notifications targeted to explicit assistant errors and provider failure messages; avoid recursively scanning arbitrary event payloads because normal message text can otherwise trigger false-positive error toasts.
