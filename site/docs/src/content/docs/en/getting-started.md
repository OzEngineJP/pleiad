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
2. In Pleiad, open Settings › "Agents" and press "Recheck status" so Pleiad finds the installed CLI. While you wait after pressing "Install", Pleiad notices the install by itself and the row switches without a press.
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
- Claude needs the Claude Agent SDK as well as the CLI. After you install, Pleiad downloads it alongside the CLI and shows the progress on the Claude row. If the download fails, press "Try again" on the row.
- OpenCode's free models work without signing in; sign in when you want to connect other providers.
- When you are using Pleiad from a phone or another PC, sign in on the PC where Pleiad runs (the host).

See [Agents](./agents/) for the list of agents Pleiad can connect to.

## Start your first conversation

The first time you launch Pleiad, a "Welcome to Pleiad" screen appears.

1. Pick the **agent to use**. The list shows every agent — rows for agents that are not installed show "Install", and ones you are not signed in to show "Sign in", so you can connect right there. For agents whose install command is known, the row also shows the command with "Copy".
2. Pick a **working directory**. The agent reads and writes files inside this folder.
3. Press "Start conversation".

Then just write what you want in the message box and send it. For actions that need care — changing files, running commands — an approval prompt appears (answer with "Allow", "Always allow", or "Deny").

This screen cannot be closed (and "Start conversation" stays disabled) until at least one agent is usable. As soon as one is, it is selected and you can continue. Even after you have finished this screen once, if no agent is usable when Pleiad starts, a "No agent is available" screen appears.

If you send a message and the agent can't be found, the send line shows "Resend" and "Cancel". Install or sign in right there, then press "Resend" to carry on.

You can change the agent and working directory in the conversation at any time. You can also add agents and sign in later under Settings › "Agents".

## Open visualizations and files in the side panel

When an agent produces HTML or a visualization, it appears as a card in the conversation. In the side panel (the conversation browser) you can open them as pages, alongside files, folders, git, and plugins.

- "Open in page" on a card opens the **current contents of the original HTML** in the side panel. If the original file is gone, it switches to the version saved in the conversation and tells you so.
- Under "+" (new tab), "This conversation" lists shortcuts to Changes and Plugins, plus the conversation's visualizations (newest five with "Show all"). Pressing a row opens the original HTML; records without a recorded original open the "saved version" directly.
- A "saved version" tab shows a "Saved version" badge and its title in the address bar. It is a snapshot of how it looked when saved — not the current original file.
- Cards have an "Open in default browser" button, and the "⋯" on a row or card lets you reveal the original in Explorer, copy its path, open the saved version, or save the HTML (records without an original path do not show path-based actions. On screens opened from another device, actions that operate on the PC running Pleiad are not shown).

## Change a bot’s icon

On the bot’s page, press the round icon with the pencil badge. Choose "Not set", "Choose emoji", or "Choose image". An unset icon shows the first character of the name. Images can be PNG, JPEG, or WebP, up to 10 MB.

When an image is set, use the same round icon to change or remove it. Choosing an emoji or "Not set" removes the image. "Remove image" removes only the image and restores the previous emoji or the first character of the name.

## Delete a bot you created

On the bot's page, press the "⋯" next to "Open DM" and choose "Delete bot…". You can also right-click the bot in the sidebar. Review what will be deleted and which conversations will be kept, then press "Delete". Built-in bots cannot be deleted.

Deleting a bot removes its settings, activity notes, and dedicated memories, and pauses its routines. Shared memories about you are kept. Past conversations remain available under temporary chats for reading, but you cannot send more messages to them. If work, approval, or sending is pending, wait for it to finish before deleting the bot. Deletion cannot be undone.
