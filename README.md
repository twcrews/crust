# Crust: Pi Coding Agent Extension for VS Code

Crust is an extension for Visual Studio Code that acts as a true UI for the [Pi Coding Agent](https://pi.dev/).

The goal of Crust is to offer feature parity with existing similar extensions (like the [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)).

## Features

- **Session browser** — view and resume your past Pi agent sessions
- **IDE file/selection context** — automatically attach the current file or highlighted code as context to your prompt
- **Command autocomplete with `/`** — discover and insert slash commands
- **File autocomplete with `@`** — reference workspace files in your prompt without leaving the chat
- **Rich markdown rendering** — responses render with full markdown: headings, tables, code blocks, and more
- **Rich diff snippets** — code changes are shown as inline diffs so you can review edits at a glance

### Planned Features

- **Session forking** — branch off from any point in a session to explore alternative directions
- **Session tree browsing** — visualize and navigate the full tree of forked sessions
- **Login/logout** — manage model provider credentials directly from the extension
- **Change reversion** — roll back file changes made during a session with a single click
- **Settings UI** — configure Pi through a dedicated settings panel
- **Chat import/export** — save sessions to disk or load them back into the extension
- **Session sharing** — generate a shareable link to a session for collaboration or review

## Requirements

Crust requires that Pi be installed and available in your `PATH`.

Follow Pi's documentation to get started: https://pi.dev/docs/latest/quickstart

## Limitations

- **`/reload` is emulated** — Pi's TUI has a built-in `/reload` command for reloading keybindings, extensions, skills, prompts, and themes. Pi RPC mode does not currently expose that command directly, so Crust emulates it by restarting its `pi --mode rpc` child process, restoring the active session, and refreshing models and slash commands. This reloads Pi-side resources without reloading the VS Code extension host; changes to Crust's own extension code or VS Code contributions still require the normal VS Code extension reload workflow.

## Contributing

Feel free to submit issues or open pull requests with features and bug fixes on GitHub!

---

> *S. D. G.*