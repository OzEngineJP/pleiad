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

The desktop app notifies you about updates automatically. You can also check manually under Settings › "About & updates". You can also ask in a conversation, for example "update Pleiad" or "restart Pleiad": the agent checks for, downloads and applies the update, or restarts on the same version, and confirms the result after reconnecting (applying and restarting follow the conversation's approval settings).

## Connect an agent

Pleiad is a host for AI agents. Each agent you use needs its own CLI installed and its own sign-in. Pricing and terms belong to each agent's provider.

1. Install the agent's CLI (each agent's guide explains how — the "Install" button under Settings › "Agents" opens it too).
2. In Pleiad, open Settings › "Agents" and press "Recheck status" so Pleiad finds the installed CLI. While you wait after pressing "Install", Pleiad notices the install by itself and the row switches without a press.
3. Open "Connections" on the agent's row and press "Sign in" on the "CLI login" card.
4. When the row shows "Signed in", the agent is ready to use.

How sign-in proceeds differs per agent:

| Agent | How you sign in | Signing out |
| --- | --- | --- |
| Claude | Open the sign-in page in a browser and authorize with your Anthropic account | "Sign out" on the "CLI login" card |
| Codex | Open the sign-in page in a browser and authorize with your ChatGPT account | "Sign out" on the "CLI login" card |
| Antigravity | Run the shown command (`agy`) in a terminal and sign in with Google | Done on the `agy` side (credentials live in the OS credential store) |
| OpenCode | Run `opencode auth login` in a terminal and pick a provider | Run `opencode auth logout` in a terminal |
| Devin | Run `devin auth login` in a terminal and authorize in a browser | "Sign out" in Pleiad |
| Grok | Run `grok login` in a terminal (`grok login --device-auth` when there is no browser) | "Sign out" on the "CLI login" card |

- For Claude, Codex, OpenCode and Grok, "Connections" lists the CLI login, any accounts you added and compatible endpoints in one list. Add one with "+ Add connection" and pick the one new chats use with "Make default". Antigravity and Devin keep "Sign in" / "Sign out" on the row.
- Sign-in waits for about 10 minutes. Press "Cancel" to stop waiting.
- Claude needs the Claude Agent SDK as well as the CLI. Press "Download" on the Claude row — you don't have to wait for the CLI install or sign-in to finish. If the download fails, press "Try again" on the row.
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

Conversation to-dos prompt the agent to read the list before work, add tasks for work with three or more steps, and record starts, completions, and outputs. This is on by default for all agents, including delegated conversations. To turn it off, open "Instructions" in Settings, then "Pleiad instructions", and switch off "Conversation to-dos".

## Open visualizations and files in the side panel

When an agent produces HTML or a visualization, it appears as a card in the conversation. In the side panel (the conversation browser) you can open them as pages, alongside files, folders, git, and plugins.

- "Open in page" on a card opens the **current contents of the original HTML** in the side panel. If the original file is gone, it switches to the version saved in the conversation and tells you so.
- Under "+" (new tab), "This conversation" lists shortcuts to Changes and Plugins, plus the conversation's visualizations (newest five with "Show all"). Pressing a row opens the original HTML; records without a recorded original open the "saved version" directly.
- A "saved version" tab shows a "Saved version" badge and its title in the address bar. It is a snapshot of how it looked when saved — not the current original file.
- Cards have an "Open in default browser" button, and the "⋯" on a row or card lets you reveal the original in Explorer, copy its path, open the saved version, or save the HTML (records without an original path do not show path-based actions. On screens opened from another device, actions that operate on the PC running Pleiad are not shown).

## "Chats" and "Bots" in the sidebar

The switch at the top of the sidebar picks one of two lists.

- **Chats**: ordinary conversations only.
- **Bots**: routines, bots (with their DM threads underneath), and channels. Ask a bot to do something from a DM or a channel in this list.

## Create a bot

In the Bots list, press "＋" on the "Bots" heading. If you have no bots yet, opening the Bots list starts at step 1.

1. Enter a **name**.
2. Choose a **color**.
3. Write a **persona** (personality, role, tone) and press "Create". The persona can be left empty.

"Next" and "Back" move between steps. The agent, model, and approval mode are set to their defaults and can be changed later on the bot's page. When the bot is created, its DM opens.

## Change a bot's color

A bot's face is a single big-eyed face. You can only choose one of 8 colors — emoji and images are no longer available. On the bot's page, press the face and pick a color; it changes right away.

Bots that previously had an emoji or an image are shown with a colored face (the saved emoji and image are kept but not used for display).

## Call a bot with @

Type `@` in the input of a channel or its thread to see bot suggestions. The bot you pick becomes one block of "face + name", and one Backspace or the block's "×" removes it. You can line up as many as you like, and all of them are reached. After sending, the recipients still show as blocks in the bot's color.

- **Without @**: in a DM the message goes to that bot; in a thread a bot has already answered, it goes to the bot that answered before. A channel's first post, or a thread no bot has answered yet, gets no response. Before you send, a line above the input says "Nobody is mentioned, so no bot will respond" with a "Call @bot" button; press it to insert the block.
- **Bots that aren't members**: calling a bot that isn't a channel member with `@` adds it to the members when you post, and tells you ("Added … to the channel members").
- **How a bot runs**: under a thread's input there are only attachments and send. The model, working folder, and approval mode are set on the bot's page (they can't be changed per thread).

## Delete a bot you created

On the bot's page, press the "⋯" next to "Open DM" and choose "Delete bot…". You can also right-click the bot in the sidebar. Review what will be deleted and which conversations will be kept, then press "Delete". Built-in bots cannot be deleted.

Deleting a bot removes its settings, activity notes, and dedicated memories, and pauses its routines. Shared memories about you are kept. Past conversations remain available under Chats for reading, but you cannot send more messages to them. If work, approval, or sending is pending, wait for it to finish before deleting the bot. Deletion cannot be undone.
