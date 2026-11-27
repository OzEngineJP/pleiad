---
title: Memory
description: What bots remember, the three ways a memory is given to the AI (Every time, Only in this folder, Not given), and the nightly organizing settings (relearning from conversations, deciding when each memory is given) — where to set them, what the defaults are, and what turning them on does.
---

Bots hold memories — short factual notes grounded in things you said — and receive them at the start of a conversation. You can see them on the bot page under "Memory": two layers, "About you" (shared across all bots) and "This bot only". Each line can be edited or forgotten.

Memory settings live under "Memory" in Settings › "Bots".

Use "Enable bots" in Settings › "Bots" to turn bot replies, proactive activity, and nightly memory organizing on or off together. Bots are off on a new installation. You can still open saved memories with "View memory" when bots are off.

## When a memory is given

Each line carries a badge showing when it is given to the AI: "Every time", "Only in this folder", or "Not given" ("Not decided yet" for lines that haven't been decided).

| Badge | How it is given |
| --- | --- |
| Every time | Given at the start of every conversation, whatever the workspace. |
| Only in this folder | Given only in conversations in that working folder. The workspace is decided from the working folder of the conversation where it was learned (for a git repository, the repository root; a worktree counts as the same place as its original repository). |
| Not given | Kept, but never given to the AI. You can see it in the list and change it later. |

- The amount given at the start of a conversation is at most 9,000 tokens in total. Memories that don't fit are given when they relate to the topic.
- Memories you write are "Every time". Memories a bot writes are "Only in this folder" when the conversation has a workspace, and "Every time" otherwise.
- "Edit" on a line lets you change when it is given — and, for "Only in this folder", the workspace — as well as the text.
- "Not decided yet" memories are given the way they always were until nightly organizing decides them (see "Deciding when memories are given" below).

## Promises and progress

Promises and work progress are not written to memory. They go to the thread's to-do list if it has one, and otherwise to the bot's concerns. Existing promise memories move to "Not given" (they are not deleted).

## Nightly organizing

"Relearn from conversations every night" in Settings › "Bots" re-reads conversations at a set time (02:00 by default) and writes what matters into memories. **It is off by default** — for both new users and users upgrading from an earlier version. Nothing runs until you turn it on. Toggling it never deletes the memories you already have.

Besides learning new things, it also re-decides when already-saved memories are given (up to 20 per run; the bot page's "Memory" shows "re-decided when to give N" in the organizing result). It doesn't send all memories, only the ones that relate.

- **Time**: the local time organizing starts.
- **Carry a thread's story into the next thread**: briefly sums up a bot thread that has gone quiet and hands it over at the start of the same bot's next thread. Only runs while nightly organizing is on. Off by default; the switch is kept even if you turn organizing off.

While nightly organizing is off, the time and the carry-over switch can't be changed (their values are kept).

The "Rebuild context from records at conversation boundaries, without summarizing" switch is not here: it affects every conversation, not just memory, so it sits at the top of Settings › "Auto compaction" (its on/off state carries over unchanged from the old "Experimental" page).

### The agent used for organizing

Organizing and summarizing are done through one-off internal calls (the agent and model follow the organizing settings). They are not retained as a Pleiad conversation or as conversation history on the agent side.

- **Agents that can run them**: Claude, Codex
- **Agents that cannot**: Antigravity, Devin, Grok, OpenCode — Pleiad cannot guarantee that no conversation is left on the agent side, so organizing does not run and the status line shows why (it does not silently switch to an ordinary conversation)

Conversations that earlier versions created for internal organizing are kept out of conversation lists, search, and recent locations when they can be identified reliably (the data is not deleted).

### Status and actions

Below the switches, a status line shows what nightly organizing is doing.

- **On**: waiting for the next scheduled run. "Organize now" runs it once right away.
- **Organizing**: it's running now.
- **Failed / Stopped**: waiting to retry after a failure, or stopped — by a problem such as authentication or by the retry limit. "Try again" restarts it.
- **Waiting for sign-in**: the agent used for organization is signed out — sign in to continue. If organization has stopped after a failure, resume with "Try again" after signing in (a stopped state does not come back from signing in alone).
- **Connection unconfirmed**: Pleiad couldn't tell passively whether the agent is connected. A connection check that may open a sign-in screen only happens when you press "Check connection".

The bot page's "Memory" heading also shows "Nightly organizing: … ›", which opens this settings page. The "See memories" row lists your bots; pressing one opens that bot's page.

## Deciding when memories are given

Memories that are "Not decided yet" are decided by the AI a little at a time at the end of nightly organizing — into "Every time", "Only in this folder", or "Not given". **There is nothing to start.** While nightly organizing is on, up to 500 are decided per night (about 3 nights for 1,490 memories). While it is off, nothing runs. Until a memory is decided, it is given the way it always was.

- Memory text is never rewritten. Only when it is given and the workspace are set. A memory whose workspace can't be decided becomes "Not given".
- It runs on the agent used for organizing (the same as "The agent used for organizing" above).
- Settings › "Bots" shows "N memories with no set time to be given", "Deciding 500 each night (about N more nights)", and a breakdown of what was decided. If a night didn't go well, it continues from where it left off the next night.
- To stop it, turn "Relearn from conversations every night" off. What has been decided stays.
- "Undo what was decided" removes what was decided (it works even while nightly organizing is off). Memories you edited afterwards are not reverted. After undoing, it won't decide again until you turn "Relearn from conversations every night" back on.
