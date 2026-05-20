# Change Log

All notable changes to the Crust extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.8.0] - 2026-05-20

- Added support for `/clone`, `/export`, `/session`, `/changelog`, emulated `/reload`, and `/quit` slash commands.
- Added configurable Pi startup/chat/markdown settings, including command path, default model, restored tabs, IDE context defaults, and raw HTML rendering.
- Switched chat rendering to a vendored `markdown-it` bundle with richer Markdown support and optional sanitized raw HTML.
- Added project file link rendering/validation and copy controls for tool output cards.
- Improved path autocomplete, segmented text rendering, RPC logging verbosity, and release/test coverage.
- Updated agent guidance for the current architecture and generated Markdown bundle.

## [0.7.0] - 2026-05-18

- Added manual `/compact` chat flow with optional custom instructions and session status refreshes.
- Rendered compaction results and restored compaction summaries as expandable shaded chat bubbles.
- Expanded built-in slash command fallbacks and test coverage for compaction behavior.
- Updated release staging instructions and agent guidance.

## [0.6.2] - 2026-05-18

- Improved provider error rendering in chat, including errors reported on `message_end` events.
- Pretty-printed structured provider error payloads for easier diagnosis.
- Refactored chat panel rendering and session restore logic into focused modules.
- Expanded tests for Pi RPC client behavior, streaming event rendering, and session restore rendering.
- Updated agent guidance for the current split chat panel architecture.

## [0.6.1] - 2026-05-18

- Fixed false-positive model error notifications from normal streamed assistant text.
- Updated agent guidance for current error-notification behavior.

## [0.6.0] - 2026-05-18

- Added support for multiple concurrent Crust chat instances, including restored session paths per tab.
- Added structured Crust logging utilities and forwarded webview log levels for easier debugging.
- Improved Pi RPC error handling, including clearer subscription-related errors.
- Reduced routine logging verbosity while keeping critical errors visible.
- Expanded runtime guards and tests for RPC events, webview messages, path autocomplete, and restored sessions.
- Updated release staging instructions and agent guidance.

## [0.5.0] - 2026-05-17

- Added terminal-style prompt history recall and keyboard shortcuts for prompt cancellation.
- Forwarded critical Pi RPC errors to VS Code notification toasts.
- Improved `read` tool output rendering with line number information.
- Expanded tests for prompt shortcuts and tool output formatting.

## [0.4.0] - 2026-05-16

- Added automatic restoration for persisted Crust chat tabs when VS Code windows load.
- Added copy-to-clipboard controls for fenced code blocks in chat messages.
- Improved chat opening and reveal behavior by focusing the prompt automatically.
- Expanded tests for restored webview sessions, prompt focus, and copyable code blocks.

## [0.3.0] - 2026-05-15

- Added task cancellation and steering controls for active Pi requests.
- Added support for older VS Code versions and CI/test coverage across minimum and current VS Code releases.
- Improved usage status reporting and shortened current-working-directory display in chat status text.
- Constrained user prompt bubble width for improved chat readability.
- Added Dependabot configuration and refreshed development dependencies.

## [0.2.0] - 2026-05-15

- Added a release staging prompt for verifying, documenting, committing, and tagging releases without publishing.
- Improved slash command discovery and autocomplete with command deduplication, source metadata normalization, refreshes, and fuzzy matching.
- Improved restored skill and slash command display in chat history.
- Fixed tool use streaming correlation and tool card sizing.
- Expanded tests for RPC guards, slash command metadata, restored prompts, tool utilities, and webview rendering.

## [0.1.0] - 2026-05-14

- Added rendering for `bash` tool use, including command display and captured output.
- Added markdown rendering to user prompt bubbles.
- Expanded the chat UI to use the available webview width while keeping controls readable.
- Improved tool card headers so long command or path details remain accessible.
- Improved slash command autocomplete description contrast in active and hover states.

## [0.0.3] - 2026-05-14

- Fixed chat webview alignment by constraining message content without constraining controls.
- Fixed missing CSS rule closures affecting markdown, conversation navigation hover state, and loading message text.

## [0.0.2] - 2026-05-14

- Added the GitHub repository URL to the extension package metadata.

## [0.0.1] - 2026-05-14

- Initial release

[0.8.0]: https://github.com/twcrews/crust/compare/0.7.0...0.8.0
[0.7.0]: https://github.com/twcrews/crust/compare/0.6.2...0.7.0
[0.6.2]: https://github.com/twcrews/crust/compare/0.6.1...0.6.2
[0.6.1]: https://github.com/twcrews/crust/compare/0.6.0...0.6.1
[0.6.0]: https://github.com/twcrews/crust/compare/0.5.0...0.6.0
[0.5.0]: https://github.com/twcrews/crust/compare/0.4.0...0.5.0
[0.4.0]: https://github.com/twcrews/crust/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/twcrews/crust/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/twcrews/crust/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/twcrews/crust/compare/0.0.3...0.1.0
[0.0.3]: https://github.com/twcrews/crust/compare/0.0.2...0.0.3
[0.0.2]: https://github.com/twcrews/crust/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/twcrews/crust/tree/0.0.1