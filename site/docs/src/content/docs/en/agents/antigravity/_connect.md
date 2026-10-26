<!-- Hand-written fragment (connecting). generate.mjs embeds this into Antigravity's page.
     The leading underscore keeps this file from becoming a page of its own. -->

## Connecting

1. Install the Antigravity CLI (`agy`) ([install guide](https://antigravity.google/docs/cli/install/)).
2. In Pleiad, open Settings › "Agents" and press "Recheck status" on the Antigravity row.
   - On Windows, the installer places `agy` under `%LOCALAPPDATA%\agy\bin`, then `agy install` updates PATH. If Pleiad does not find it, press "Recheck status" or restart Pleiad.
3. Press "Sign in". Pleiad shows a command to run in a terminal. Press "Copy", run it, and follow the prompts to sign in with your Google account (Antigravity sign-in can only be done from a terminal).
4. The row switches to "Signed in" automatically when it finishes (it times out after about 10 minutes).

- Signing out of Antigravity cannot be done from Pleiad — do it on the `agy` side (the credentials live in the OS credential store).
- To stop waiting for sign-in, press "Cancel".
