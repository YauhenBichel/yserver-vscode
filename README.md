# yserver-vscode

A VS Code extension for working with your own LLM server, with no cloud model. It works with any
OpenAI-compatible server (llama.cpp, Ollama, vLLM, a gateway in front of them) and has no runtime
dependencies.

## Features

- **Ask about the selection** (Cmd+Alt+Y, Ctrl+Alt+Y on Linux and Windows): your question and the selected
  code go to the server. The answer streams into a Markdown document beside your code, and it shows when
  the model is still thinking.
- **Run a skill on the selection** (Cmd+Alt+S, Ctrl+Alt+S): pick a skill (debug, review-code,
  write-tests, ...); its step-by-step method goes with the request. Skills are folders of `SKILL.md`
  files, for example [engineering-skills](https://github.com/YauhenBichel/engineering-skills).
- **Apply the last code block:** replaces the selection with the last code block of the answer, after you
  confirm.
- **Stop the answer.**
- **Status bar:** the model loaded on the server and how many requests are waiting. This needs a gateway
  that serves `/v1/system` and `/metrics`; with other servers it shows only whether the server is up.
- **Pause and resume background services** on the server over SSH (`systemctl --user`), after you confirm.
  Useful when batch jobs keep the GPU busy while you code.
- **Open a page:** dashboards or status pages you list in the settings.

Rules in [Continue](https://continue.dev)'s format (Markdown files with `alwaysApply` or `globs`) are sent
with every request, from `yserver.rulesDir`.

Requests carry the header `x-yllm-priority: interactive`, so a gateway with a priority queue serves them
before background work. Other servers ignore it.

## Install

The extension is not on the Marketplace yet. Build it:

```bash
npm install
npm test
npm run package
code --install-extension yserver-vscode-0.1.1.vsix
```

## Settings

Search for "yserver" in VS Code's settings. Only `yserver.baseUrl` is required.

| Setting | What it is |
|---|---|
| `yserver.baseUrl` | Address of the server, for example `http://localhost:8080` |
| `yserver.apiKey` | API key, if the server asks for one |
| `yserver.model` | Model name sent with each request |
| `yserver.interactive` | Send `x-yllm-priority: interactive` (default on) |
| `yserver.memory` | Let a gateway with memory add its stored notes (default off: sends `x-yllm-memory: off`) |
| `yserver.maxTokens` | Room for the answer, including a thinking model's hidden reasoning (default 16000) |
| `yserver.skillsDirs` | Folders of skills (`<name>/SKILL.md`) |
| `yserver.rulesDir` | Folder of Markdown rules (default `~/.continue/rules`) |
| `yserver.sshHost` | SSH host of the server, for pausing services |
| `yserver.pipelines` | systemd user services to pause and resume |
| `yserver.pages` | Pages for the menu: `{"label": "url"}` |
| `yserver.refreshSeconds` | How often the status bar updates (default 10) |

Example (`settings.json`):

```json
{
  "yserver.baseUrl": "http://localhost:8080",
  "yserver.model": "qwen3-coder",
  "yserver.skillsDirs": ["~/engineering-skills/skills"]
}
```

## Development

`src/core.ts` holds everything that does not need VS Code (skills, rules, the request, the stream, the
status), with tests in `test/`. `src/extension.ts` is the VS Code part.

## License

Apache-2.0. Part of [yserver](https://github.com/YauhenBichel/yserver-local-llm-system), a home LLM server.
