---
title: Getting started
description: Install Pleiad, connect an agent, and start your first conversation.
---

## Install

Get the build for your OS from [Download](https://pleiad.dev/download/).

- **Windows** (10 / 11): x64 or ARM64 installer. SmartScreen may appear on first launch — choose "More info" → "Run anyway".
- **macOS** (13 or later): Apple Silicon / Intel installer.
- **Linux**: there is no desktop app. There is a [browser version you run from source](https://github.com/OzEngineJP/pleiad#run-from-source).
- **Android** (13 or later): an app (APK) that connects to Pleiad running on your PC. It needs a relay server.

The desktop app notifies you about updates automatically. You can also check manually under Settings › "About & updates".

## Connect an agent

Pleiad is a host for AI agents. Each agent you use needs its own CLI installed and its own sign-in. Pricing and terms belong to each agent's provider.

1. Install the agent's CLI (each agent's guide explains how — the "Install" button under Settings › "Agents" opens it too).
2. In Pleiad, open Settings › "Agents" and press "Recheck status" so Pleiad finds the installed CLI.
3. Press "Sign in" on the agent's row.
4. When the row shows "Signed in", the agent is ready to use.

How sign-in proceeds differs per agent:

| Agent | How you sign in | Signing out |
| --- | --- | --- |
| Claude | Open the sign-in page in a browser and authorize with your Anthropic account | "Sign out" in Pleiad |
| Codex | Open the sign-in page in a browser and authorize with your ChatGPT account | "Sign out" in Pleiad |
| Antigravity | Run the shown command (`agy`) in a terminal and sign in with Google | Done on the `agy` side (credentials live in the OS credential store) |
| OpenCode | Run `opencode auth login` in a terminal and pick a provider | Run `opencode auth logout` in a terminal |
| Devin | Run `devin auth login` in a terminal and authorize in a browser | "Sign out" in Pleiad |
| Grok | Run `grok login` in a terminal (`grok login --device-auth` when there is no browser) | "Sign out" in Pleiad |

- Sign-in waits for about 10 minutes. Press "Cancel" to stop waiting.
- Claude also needs the Claude Agent SDK fetched on first use (a notice appears on the Claude row).
- OpenCode's free models work without signing in; sign in when you want to connect other providers.
- When you are using Pleiad from a phone or another PC, sign in on the PC where Pleiad runs (the host).

See [Agents](./agents/) for the list of agents Pleiad can connect to.

## Start your first conversation

The first time you launch Pleiad, a "Welcome to Pleiad" screen appears.

1. Pick the **agent to use**. The list shows every agent — rows for agents that are not installed show "Install", and ones you are not signed in to show "Sign in", so you can connect right there.
2. Pick a **working directory**. The agent reads and writes files inside this folder.
3. Press "Start conversation".

Then just write what you want in the message box and send it. For actions that need care — changing files, running commands — an approval prompt appears (answer with "Allow", "Always allow", or "Deny").

You can change the agent and working directory in the conversation at any time. You can also add agents and sign in later under Settings › "Agents".
