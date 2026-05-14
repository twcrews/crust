# AGENTS.md

Guidance for coding agents working in this repository.

## Project context

Crust is a Visual Studio Code extension that provides a VS Code chat UI for the [Pi Coding Agent](https://pi.dev/). The goal remains feature parity with comparable coding-agent extensions, including session browsing, IDE context integration, chat export, and diff viewing.

The project now contains an initial real implementation rather than only VS Code template code. The extension contributes `crust.openChat`, opens a locked side-by-side chat webview, starts Pi with `pi --mode rpc`, streams assistant responses, displays file tool activity, supports model selection, and can browse/restore previous Pi JSONL sessions.

## Current architecture

- `src/extension.ts` contains extension activation and command registration only.
- `src/pi/piRpcClient.ts` owns the Pi RPC child process, JSONL request/response handling, event forwarding, and RPC logging.
- `src/pi/rpcTypes.ts` contains lightweight runtime guards and shared Pi RPC types.
- `src/ui/chatPanel.ts` coordinates the VS Code webview panel, Pi RPC client, session restore, model/status updates, streaming messages, thinking blocks, and file tool cards.
- `src/ui/chatWebview.ts` loads the static webview template and injects CSP nonce/resource URIs.
- `media/chatWebview.html`, `media/chatWebview.css`, and `media/chatWebview.js` implement the webview UI. The webview script is plain JavaScript and is syntax-checked separately.
- `branding/` contains extension and webview icons.

## Working guidelines

- Treat `README.md` as the source of truth for current project goals and status, but keep this file updated when architecture or workflow changes.
- Prefer small, focused changes with clear separation between extension activation, Pi integration, UI/webview code, and VS Code command registration.
- Keep user-facing behavior aligned with VS Code extension conventions.
- Assume Pi must be installed and available on `PATH`, as documented in `README.md`.
- Avoid introducing framework or bundling complexity for the webview unless there is a clear need; the current webview assets are static files under `media/`.
- Preserve the RPC/webview boundary: extension code should talk to Pi and VS Code APIs, while the webview should handle DOM rendering and post typed messages back to the extension.

## Development commands

Use the scripts defined in `package.json` for validation and builds. Common checks include:

```sh
npm run compile
npm run lint
npm run check-webview
```

`npm run compile` runs type checking, linting, webview syntax checking, and the esbuild bundle. `npm run package` performs the production build used by `vscode:prepublish`.

## Notes

- Avoid adding large generated artifacts unless they are required by the extension packaging workflow.
- Keep documentation updated as features move beyond the current implementation.
- Logs are available in the `Crust` and `Crust Pi RPC` output channels when debugging extension/Pi behavior.
