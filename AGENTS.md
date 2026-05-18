# AGENTS.md

Guidance for coding agents working in this repository.

## Project context

Crust is a Visual Studio Code extension that provides a VS Code chat UI for the [Pi Coding Agent](https://pi.dev/). The goal remains feature parity with comparable coding-agent extensions, including session browsing, IDE context integration, slash/file autocomplete, rich rendering, and diff viewing.

The project has a real implementation rather than only VS Code template code. The extension contributes `crust.openChat`, opens a locked side-by-side chat webview (also bound to `cmd+ctrl+escape` and the editor title menu), starts Pi with `pi --mode rpc`, streams assistant responses/thinking/tool activity, supports model selection and usage/status display, can browse/restore previous Pi JSONL sessions, starts new chats, runs supported slash commands, and can attach current editor file/selection context to prompts. Multiple Crust webview instances can coexist and restored tabs are serialized with their session paths.

## Current architecture

- `src/extension.ts` contains extension activation and command registration only.
- `src/pi/piRpcClient.ts` owns the Pi RPC child process, JSONL request/response handling, event forwarding, supported RPC commands (`prompt`, `steer`, abort, model/session changes, compact, slash command discovery), and RPC logging.
- `src/pi/rpcTypes.ts` contains lightweight runtime guards and shared Pi RPC types, including typed tool result/event shapes.
- `src/ui/chatPanel.ts` coordinates each VS Code webview panel, Pi RPC client, session restore/new chat, model/status/usage updates, IDE context injection, slash commands, `@` path autocomplete, streaming messages, thinking blocks, task cancellation/steering, tool cards/diffs, and targeted model-connection error notifications.
- `src/ui/chatTypes.ts`, `ideContext.ts`, `messageUtils.ts`, `pathAutocomplete.ts`, `sessionHistory.ts`, `toolUtils.ts`, and `usageStatus.ts` hold focused UI-side parsing, formatting, session, filesystem, and tool helpers.
- `src/ui/chatWebview.ts` loads the static webview template and injects CSP nonce/resource URIs.
- `src/utils/crustLogger.ts`, `errorMessage.ts`, and `nonce.ts` provide output-channel logging, error stringification, and CSP nonce generation.
- `media/chatWebview.html` and the plain CSS/JavaScript files under `media/chatWebview/` implement the webview UI. The webview scripts are syntax-checked separately; they handle manual markdown rendering, copyable code blocks, inline diff rendering, slash and path autocomplete, IDE context toggling, persisted webview state, prompt history recall, cancellation shortcuts, empty states, conversation navigation, and logging back to the extension.
- `branding/` contains extension and webview icons.
- `src/test/extension.test.ts` contains the VS Code integration/unit test suite for RPC guards, webview message validation, IDE context, tool utilities, usage formatting, path autocomplete, session history, and static webview behavior.
- `.github/workflows/ci.yml` runs CI validation; `.github/dependabot.yml` manages dependency update PRs.

## Working guidelines

- Treat `README.md` as the source of truth for current project goals and status, but keep this file updated when architecture or workflow changes.
- Prefer small, focused changes with clear separation between extension activation, Pi integration, UI/webview code, and VS Code command registration.
- Keep user-facing behavior aligned with VS Code extension conventions.
- Assume Pi must be installed and available on `PATH`, as documented in `README.md`; some features also shell out to `git` or inspect the installed Pi CLI for built-in slash command metadata.
- Avoid introducing framework or bundling complexity for the webview unless there is a clear need; the current webview assets are static files under `media/`.
- Preserve the RPC/webview boundary: extension code should talk to Pi, the filesystem, Git, and VS Code APIs, while the webview should handle DOM rendering and post typed messages back to the extension.
- Keep restored sessions compatible with Pi JSONL history, including Crust's `<ide_context>` prompt wrapper and Pi skill wrapper stripping/display logic.

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

- Avoid adding large generated artifacts unless they are required by the extension packaging workflow.
- Keep documentation updated as features move beyond the current implementation.
- Logs are available in the `Crust` and `Crust Pi RPC` output channels when debugging extension/Pi behavior.
- Keep model/provider error notifications targeted to explicit assistant errors and provider failure messages; avoid recursively scanning arbitrary event payloads because normal message text can otherwise trigger false-positive error toasts.
