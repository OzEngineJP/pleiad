---
title: Memory
description: What bots remember and the automatic memory organization settings — where to set them, what the defaults are, and what turning organization on does.
---

Bots hold memories — short factual notes grounded in things you said — and receive them at the start of a conversation. You can see them on the bot page under "Memory": two layers, "About you" (shared across all bots) and "This bot only". Each line can be edited or forgotten.

Memory settings live in Settings › "Memory".

## General

The "Rebuild context from records at conversation boundaries" switch. While on, at conversation boundaries (after idle time or an agent switch) Pleiad rebuilds the handoff from its records — your messages, an index, and recent exchanges — instead of a summary (idle auto compaction is stopped during this).

This is the same setting that used to live under "Experimental"; its on/off state carries over unchanged.

## Bots

"Automatic memory organization" re-reads conversations at a set time and writes what matters into memories. **It is off by default** — for both new users and users upgrading from an earlier version. Nothing runs until you turn it on. Toggling it never deletes the memories you already have.

- **Organize at**: the local time organization starts.
- **Summarize and hand off bot conversations**: summarizes quiet bot conversations and hands them off to the next one. Only runs while automatic organization is on. Off by default; the switch is kept even if you turn organization off.

While organization is off, the time and the summary switch can't be changed (their values are kept).

### The agent used for organizing

Organizing and summarizing are done through one-off internal calls to a light model. They are not retained as a Pleiad conversation or as conversation history on the agent side.

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
