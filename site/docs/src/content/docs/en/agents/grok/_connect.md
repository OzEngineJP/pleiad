<!-- Hand-written fragment (connecting). generate.mjs embeds this into Grok's page.
     The leading underscore keeps this file from becoming a page of its own. -->

## Connecting

1. Install the Grok Build CLI (`grok`) ([setup guide](https://x.ai/cli)).
2. In Pleiad, open Settings › "Agents" and press "Recheck status" on the Grok row.
3. Press "Sign in". Pleiad shows a command (`grok login`). Press "Copy", run it in a terminal, and follow the prompts to sign in to Grok (Grok sign-in can only be done from a terminal; in environments without a browser use `grok login --device-auth`).
4. The row switches to "Signed in" automatically when it finishes (it times out after about 10 minutes).

- To sign out, press "Sign out" on the Grok row (this runs `grok logout`).
- To stop waiting for sign-in, press "Cancel".
