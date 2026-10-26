<!-- Hand-written fragment (connecting). generate.mjs embeds this into Devin's page.
     The leading underscore keeps this file from becoming a page of its own. -->

## Connecting

1. Install the Devin CLI ([setup guide](https://docs.devin.ai/cli)).
2. In Pleiad, open Settings › "Agents" and press "Recheck status" on the Devin row.
3. Press "Sign in". Pleiad shows a command (`devin auth login`). Press "Copy", run it in a terminal, and sign in to Devin in the browser that opens (Devin sign-in can only be done from a terminal).
4. The row switches to "Signed in" automatically when it finishes (it times out after about 10 minutes).

- To sign out, press "Sign out" on the Devin row (this runs `devin auth logout`).
- To stop waiting for sign-in, press "Cancel".
