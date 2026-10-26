---
title: Troubleshooting
description: Common problems, and what to do for the error text you see.
---

Common problems are grouped by startup, sign-in, conversations, and updates. If you know the exact text you saw, look it up in the [error text lookup](#error-text-lookup) below.

## Starting and opening

**Windows SmartScreen appears**
Shown on first launch. Choose "More info" → "Run anyway".

**"Pleiad failed to start" / "The server took too long to start" / "Could not start the server"**
Try launching again. If it keeps happening, restart the PC and check whether security software is blocking Pleiad.

**"The server stopped unexpectedly and could not be restarted automatically"**
Restart Pleiad. Your saved conversations are kept.

**"Disconnected" / "No reply from the server"**
Reopen the window — or restart the app on the desktop version. If it keeps happening, restart the PC.

**"The connection's authentication has expired. Reopen the URL shown at startup"**
On the browser version, the open tab's token has expired. Reopen Pleiad from the URL shown at startup.

## Agent installation

**Still "Not installed" after installing**
Press "Recheck status" under Settings › "Agents". If it still is not found, quit and relaunch Pleiad (a freshly installed CLI's location may not reach an app that is already running).

**"(agent) was not found. Install it, then check again"**
The agent's CLI is not installed. Open the install guide from [Agents](./agents/), install it, then press "Recheck status".

**The Claude Agent SDK shows "Couldn't download"**
Check your connection and press "Try again" on the Claude row.

## Sign-in

**"Couldn't sign in"**
Press "Sign in" again. Pleiad waits about 10 minutes for sign-in; press "Cancel" to stop waiting.

**"Timed out (10 minutes)" / "The terminal sign-in did not finish"**
For terminal sign-in (`agy`, `opencode auth login`, `devin auth login`, `grok login`), wait until the prompts in the terminal finish. If it did finish and you still see this, press "Sign in" to retry.

**"⚠ Your sign-in has expired"**
Press "Sign in again" and sign back in.

**Can't sign in from a remote or phone window**
Sign in on the PC where Pleiad runs (the host). Open agent settings on the host's window.

## In conversations

**Replies mention "Authentication failed" / "Couldn't sign in"**
The agent's sign-in was lost. Sign in again under Settings › "Agents".

**"This version of Claude Code cannot stop background commands. Update it with `claude update`"**
Run `claude update` in a terminal, then press "Recheck status".

**"This version of codex cannot stop background terminals. Update it with `codex update`"**
Run `codex update` in a terminal, then press "Recheck status".

**"Cannot connect to the MCP server. Check the endpoint, authentication, and launch command"**
Review the MCP server's settings (endpoint and launch command) under Settings › "Plugins". Sign in again if it needs one.

**"Sign-in timed out (10 minutes). Sign in again"**
The MCP server sign-in timed out. Press "Sign in" again on that MCP's row.

**"The screen is locked, or an administrator confirmation screen is showing"**
Shown while the agent is operating your computer. Unlock the PC and continue.

**"The computer operation was stopped because Pleiad is updating"**
Ask again after the update finishes.

**"Some attachments couldn't be sent" / "Fetching the image did not finish in time"**
Re-attach and send again, or remove the attachment.

## Updates

**"Could not get the update"**
Check your network connection, then press the check button under Settings › "About & updates" after a while. You can keep using the current version.

**"The update was not applied because its files could not be verified"**
Check again later. You can keep using the current version.

**"The new version could not start, so Pleiad is running the previous version"**
Restart Pleiad. If it keeps happening, check for the update again under Settings › "About & updates".

**"Some work didn't stop within 30 seconds. The update stays ready"**
Running work did not stop. Update again once it finishes or you stop it.

## Error text lookup

| Text you saw | What it means and what to do |
| --- | --- |
| Pleiad failed to start | The app could not start. Relaunch; if it persists, restart the PC |
| The server took too long to start / Could not start the server | The internal server could not start. Relaunch; if it persists, check security-software blocking |
| Disconnected / No reply from the server | The window lost contact with the server. Reopen the window or relaunch the app |
| The connection's authentication has expired | The browser-version tab expired. Reopen from the URL shown at startup |
| Could not migrate the saved data to the new format | This version cannot start. Keep using the previous version or contact support |
| Not installed | The CLI was not found. Press "Recheck status"; if it persists, relaunch Pleiad |
| (agent) was not found. Install it, then check again | The CLI is not installed. Install it and press "Recheck status" |
| Couldn't sign in | Try signing in again |
| Timed out (10 minutes) / The terminal sign-in did not finish | Sign-in wait timed out. Check the terminal finished, then retry |
| ⚠ Your sign-in has expired | Press "Sign in again" |
| This version of Claude Code cannot stop background commands | Run `claude update` in a terminal |
| This version of codex cannot stop background terminals | Run `codex update` in a terminal |
| Grok Build CLI is not signed in | Run `grok login` (or `grok login --device-auth` without a browser) |
| Cannot connect to the MCP server | Check the MCP's endpoint, authentication, and launch command under Settings › "Plugins" |
| Sign-in timed out (10 minutes) | Retry the MCP sign-in |
| The screen is locked, or an administrator confirmation screen is showing | Unlock the PC, then continue |
| The computer operation was stopped because Pleiad is updating | Wait for the update to finish, then retry |
| Computer use is not available in this environment | Computer use only works on the desktop host |
| This PC can't use the built-in browser (desktop app only) | The built-in browser is only available in the desktop app |
| The agent browser (Chrome) is not available on this OS or in this environment yet | Chrome control is not supported on that OS/environment yet |
| Some attachments couldn't be sent. Retry or remove them | Re-attach or remove the attachment, then send |
| Fetching the image did not finish in time | Check the connection and attach again |
| This file can't be previewed | That format is not supported for preview |
| Could not get the update | Check the network and check again later |
| The update was not applied because its files could not be verified | Check again later. The current version keeps working |
| The new version could not start, so Pleiad is running the previous version | Restart Pleiad |
| GitHub did not accept your credentials (GH_TOKEN or the GitHub CLI login) | Access to the release source is required. Check GH_TOKEN or run `gh auth login --hostname github.com` again |
| Some work didn't stop within 30 seconds | Stop the work, then update again |

## If nothing helps

You can see the version under Settings › "About & updates". Report the text you saw and what you did just before on [GitHub Issues](https://github.com/OzEngineJP/pleiad/issues).
