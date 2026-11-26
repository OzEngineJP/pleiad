<!-- Hand-written fragment (connecting). generate.mjs embeds this into Antigravity's page.
     The leading underscore keeps this file from becoming a page of its own. -->

## Connecting

1. Install the Antigravity CLI (`agy`) ([install guide](https://antigravity.google/docs/cli/install/)).
   - Pleiad runs `agy acp`, so `agy` must be version 1.5.15 or later. If yours is older, run `agy update` in a terminal.
2. In Pleiad, open Settings › "Agents" and press "Recheck status" on the Antigravity row.
   - On Windows, the installer places `agy` under `%LOCALAPPDATA%\agy\bin`, then `agy install` updates PATH. If Pleiad does not find it, press "Recheck status" or restart Pleiad.
3. Press "Sign in". Pleiad shows a command to run in a terminal. Press "Copy", run it, and follow the prompts to sign in with your Google account (Antigravity sign-in can only be done from a terminal).
4. The row switches to "Signed in" automatically when it finishes (it times out after about 10 minutes).

- Signing out of Antigravity cannot be done from Pleiad — do it on the `agy` side (the credentials live in the OS credential store).
- To stop waiting for sign-in, press "Cancel".

## Adding a second Google account

You can keep accounts with different purposes apart, such as work and personal. The account you signed in with above is the first one and keeps working as is.

1. Open "Connections" and press "+ Add connection" → "Official account".
2. A notice appears. Google's FAQ says that rotating accounts automatically to get around usage limits is not supported on individual plans. Read it and press "I understand, add it" ("Cancel" stops).
3. Enter a name (for example "Work") and press "Add and sign in". Sign in to Google in the browser that opens.

- Sign-in data for the second and later accounts is saved as a file in a folder dedicated to that account under Pleiad's data location (readable only by your Windows user). The first account's OS credential store is not touched.
- If you see "this version of agy cannot keep second and later accounts apart", run `agy update` and try again.
- If Pleiad's data location is on a different drive from your user folder, second and later accounts cannot be used.
- If you see "sign in to this connection", press "Sign in" on that account.
