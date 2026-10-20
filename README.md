<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/pleiad-lockup-dark.svg">
    <img src="assets/branding/pleiad-lockup.svg" alt="Pleiad" width="240">
  </picture>
</p>

<p align="center">One workspace for Claude Code, Codex, Antigravity, OpenCode, and Devin CLI.<br>
  <a href="https://pleiad.dev">pleiad.dev</a></p>

<p align="center">
  <a href="https://github.com/OzEngineJP/pleiad/releases"><img src="https://img.shields.io/github/v/release/OzEngineJP/pleiad?include_prereleases" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/OzEngineJP/pleiad" alt="License"></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshot-dark.png">
  <img src="docs/images/screenshot-light.png" alt="Pleiad with conversations from Claude, Codex, and Antigravity grouped by status, and a chart an agent rendered in the conversation">
</picture>

Pleiad is a desktop app for working with several coding agents side by side.
Conversations, statuses, branches, and approvals work the same way no matter which agent is behind them.

## Features

- **One list for every agent**: Claude Code, OpenAI Codex, Google Antigravity, OpenCode, and Devin CLI conversations in a single list, organized by status and group.
- **Compatible endpoints**: Point Claude Code or Codex at OpenRouter, LiteLLM, a local Ollama, and more, and pick one per conversation.
- **Branching**: Fork a conversation from any message to try another approach.
- **Approvals**: Approve tool calls right in the conversation, or set a mode per conversation, from asking every time to fully automatic.
- **Delegation**: Agents can hand work to other agents. Pleiad picks the target from the kind of task and remaining usage.
- **Stay in the conversation**: Preview files and open web pages in a side panel, and view HTML that agents render in the chat.

> [!NOTE]
> Pleiad is in beta. Features, UI, and the stored data format may change without notice.

## Install

Download from [pleiad.dev/download](https://pleiad.dev/download/) or [Releases](https://github.com/OzEngineJP/pleiad/releases).

- **Windows** 10 / 11 (x64 or ARM64). Beta builds are not signed by a trusted publisher, so Windows SmartScreen shows a warning on first launch. Choose More info → Run anyway.
- **macOS** 13 or later (Apple Silicon or Intel). Signed and notarized.
- **Linux**: run the browser version from source (see below).
- **Android** 13 or later: the remote app ships as an APK in pre-releases. It connects to Pleiad on your PC through your own relay server ([docs/remote.md](docs/remote.md)).

See [docs/desktop-releases.md](docs/desktop-releases.md) for how releases are built, signed, and updated.

Pleiad uses the agents' own CLIs and sign-ins. Install and sign in to the agents you want to use; Pleiad does not issue credentials for them.
See [docs/backends.md](docs/backends.md) for per-agent setup.

## Run from source

Requires Node.js 22.13 or later.

```bash
npm ci
npm start          # browser version; open the URL printed on startup
npm run desktop    # desktop version
npm test           # tests that do not call any LLM
```

The browser version runs on Windows, macOS, and Linux. The desktop version runs on Windows and macOS.

## Command line

`bin/pleiad.mjs` (the `pleiad` bin in `package.json`) talks to a running Pleiad. Its subcommands come from the server's operation list, so new operations appear without changing the CLI.

```bash
node bin/pleiad.mjs status
node bin/pleiad.mjs sessions list --limit 5
node bin/pleiad.mjs sessions read <id> --before 2 --after 2
node bin/pleiad.mjs settings get compaction.auto
node bin/pleiad.mjs ops                      # every available operation
node bin/pleiad.mjs call sessions.get --args '{"sessionId":"<id>"}'
node bin/pleiad.mjs sessions list --json     # JSON output
```

It finds Pleiad through `control.json` in the data folder (`AGENT_HOST_DATA`, default `~/.agent-host`). Exit codes: 0 success, 2 invalid input, 3 Pleiad is not running, 4 refused or needs the Pleiad screen, 5 other.
Inside a Pleiad conversation the shell already has `PLEIAD_CONTROL_URL` and `PLEIAD_CONTROL_TOKEN`, so the CLI acts on that conversation under its approval mode.
`pleiad mcp` serves the same operations as a stdio MCP server for AI tools outside Pleiad: `claude mcp add pleiad -- node <repo>/bin/pleiad.mjs mcp`.
Details: [Design](docs/design.md) ("操作の一覧").

## Documentation

Detailed documentation is currently in Japanese.

- [Design](docs/design.md)
- [Agent setup](docs/backends.md)
- [Releases](docs/desktop-releases.md)
- [Pleiad Plus](docs/plus.md)
- [Architecture decision records](docs/adr/)

## Security

The server listens on `127.0.0.1` by default and requires a token.
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE).

The Pleiad name and logo are not covered by this license. If you distribute a fork, use a different name.
