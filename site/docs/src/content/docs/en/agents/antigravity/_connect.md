<!-- Hand-written fragment (connecting). generate.mjs embeds this into Antigravity's page.
     The leading underscore keeps this file from becoming a page of its own. -->

## Connecting

1. Install the Antigravity CLI (`agy`) ([install guide](https://antigravity.google/docs/cli/install/)).
   - Pleiad runs `agy acp`, so `agy` must be version 1.5.15 or later. If yours is older, run `agy update` in a terminal.
2. In Pleiad, open Settings › "Agents" and press "Recheck status" on the Antigravity row.
   - On Windows, the installer places `agy` under `%LOCALAPPDATA%\agy\bin`, then `agy install` updates PATH. If Pleiad does not find it, press "Recheck status" or restart Pleiad.
3. Open "Connections" and press "Sign in" on "CLI sign-in". Sign in to your Google account in the browser that opens.
4. "CLI sign-in" switches back to "Signed in" automatically when it finishes.

- Pressing "Sign out" on "CLI sign-in" asks you to confirm. Confirming signs out both the Antigravity app on this PC and the `agy` in your terminal (the first sign-in lives in the OS credential store and is shared by the app and `agy`). "Sign out" appears only when your `agy` supports it; if it is missing, run `agy update`.
- If sign-out fails, the reason appears inside the card you pressed.
- With an older `agy` that has no "Sign out", Pleiad cannot sign you out: the "CLI login" card shows "To sign out, use the Antigravity CLI (Pleiad can't sign you out)" instead. Run `agy update` to update.
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
