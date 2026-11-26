---
title: Memory
description: What bots remember, the three tiers (Always, In this workspace, Stored only), the one-time sorting, and the automatic memory organization settings — where to set them, what the defaults are, and what turning organization on does.
---

Bots hold memories — short factual notes grounded in things you said — and receive them at the start of a conversation. You can see them on the bot page under "Memory": two layers, "About you" (shared across all bots) and "This bot only". Each line can be edited or forgotten.

Memory settings live in Settings › "Memory".

## The three tiers

Each line carries a tier badge showing how far it is given to the AI: "Always", "In this workspace", or "Stored only" ("Unsorted" for lines not sorted yet).

| Tier | How it is given |
| --- | --- |
| Always | Given at the start of every conversation, whatever the workspace. |
| In this workspace | Given only in conversations in that working folder. The workspace is decided from the working folder of the conversation where it was learned (for a git repository, the repository root; a worktree counts as the same place as its original repository). |
| Stored only | Kept, but never given to the AI. You can see it in the list and move it back up to a higher tier. |

- The amount given at the start of a conversation is at most 9,000 tokens in total. Memories that don't fit are given when they relate to the topic. How many didn't fit appears on the status line in Settings › "Memory", as "Didn't fit at the start of a conversation".
- Memories you write are "Always". Memories a bot writes are "In this workspace" when the conversation has a workspace, and "Always" otherwise.
- "Edit" on a line lets you change the tier — and, for "In this workspace", the workspace — as well as the text.
- "Unsorted" memories are given the way they always were until you finish the sorting below.

## Promises and progress

Promises and work progress are not written to memory. They go to the thread's to-do list if it has one, and otherwise to the bot's concerns. Existing promise memories move to "Stored only" (they are not deleted).

## General

The "Rebuild context from records at conversation boundaries" switch. While on, at conversation boundaries (after idle time or an agent switch) Pleiad rebuilds the handoff from its records — your messages, an index, and recent exchanges — instead of a summary (idle auto compaction is stopped during this).

This is the same setting that used to live under "Experimental"; its on/off state carries over unchanged.

## Bots

"Automatic memory organization" re-reads conversations at a set time and writes what matters into memories. **It is off by default** — for both new users and users upgrading from an earlier version. Nothing runs until you turn it on. Toggling it never deletes the memories you already have.

Besides learning new things, it also re-tiers memories you already have (up to 20 per run; the bot page's "Memory" shows "changed the tier of N" in the organization result). It doesn't send all memories, only the ones that relate.

- **Organize at**: the local time organization starts.
- **Summarize and hand off bot conversations**: summarizes quiet bot conversations and hands them off to the next one. Only runs while automatic organization is on. Off by default; the switch is kept even if you turn organization off.

While organization is off, the time and the summary switch can't be changed (their values are kept).

### The agent used for organizing

Organizing and summarizing are done through one-off internal calls (the agent and model follow the organizing settings). They are not retained as a Pleiad conversation or as conversation history on the agent side.

- **Agents that can run them**: Claude, Codex
- **Agents that cannot**: Antigravity, Devin, Grok, OpenCode — Pleiad cannot guarantee that no conversation is left on the agent side, so organizing does not run and the status line shows why (it does not silently switch to an ordinary conversation)

Conversations that earlier versions created for internal organizing are kept out of conversation lists, search, and recent locations when they can be identified reliably (the data is not deleted).

### Status and actions

Below the switches, a status line shows what the organizer is doing.

- **On**: waiting for the next scheduled run. "Organize now" runs it once right away.
- **Organizing**: it's running now.
- **Failed / Stopped**: waiting to retry after a failure, or stopped — by a problem such as authentication or by the retry limit. "Try again" restarts it.
- **Waiting for sign-in**: the agent used for organization is signed out — sign in to continue. If organization has stopped after a failure, resume with "Try again" after signing in (a stopped state does not come back from signing in alone).
- **Connection unconfirmed**: Pleiad couldn't tell passively whether the agent is connected. A connection check that may open a sign-in screen only happens when you press "Check connection".

The bot page's "Memory" heading also shows "Auto-organize: … ›", which opens this settings page.

## Memory sorting

Asks the AI once to sort memories that have no tier into "Always", "In this workspace", or "Stored only". It only runs when you press "Start sorting" under "Memory sorting" in Settings › "Memory" (it can be started even if automatic organization is off). Until you start it, memories are given the way they always were.

- Memory text is never rewritten. Only the tier and the workspace are set. A memory whose workspace can't be decided becomes "Stored only".
- It runs on the agent used for organizing (the same as "The agent used for organizing" above).
- While it runs, the status line shows how many are processed and how many are in each tier. "Stop" stops it and "Continue" resumes from where it left off. If you close the app, what has been done stays.
- Afterwards (also after stopping, or after it stopped on failures), "Undo" removes the tiers that run set. Memories you edited after the sorting are not reverted.
