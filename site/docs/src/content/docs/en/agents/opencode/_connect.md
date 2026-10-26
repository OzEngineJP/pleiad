<!-- Hand-written fragment (connecting). generate.mjs embeds this into OpenCode's page.
     The leading underscore keeps this file from becoming a page of its own. -->

## Connecting

1. Install OpenCode ([setup guide](https://opencode.ai/docs/)).
2. In Pleiad, open Settings › "Agents" and press "Recheck status" on the OpenCode row.

OpenCode's free models (OpenCode Zen) work without signing in. To connect other providers, sign in as follows.

3. Press "Sign in". Pleiad shows a command (`opencode auth login`). Press "Copy", run it in a terminal, and pick a provider to connect.
4. The row switches to "Signed in" automatically when it finishes (it times out after about 10 minutes).

- To disconnect a provider (the equivalent of signing out), run `opencode auth logout` in a terminal. It cannot be done from Pleiad.
- To stop waiting for sign-in, press "Cancel".
