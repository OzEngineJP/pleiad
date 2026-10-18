// Copied into the isolated OpenCode plugin package by writePlugin().
import fs from 'node:fs';

const SECRET = process.env.PLEIAD_OPENCODE_SECRET ?? '';
const ACCOUNT = process.env.PLEIAD_OPENCODE_ACCOUNT ?? 'login';
function endpoint(kind, session, context = false) {
  const file = process.env.PLEIAD_OPENCODE_RELAY_FILE;
  const current = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const base = current[kind] ?? process.env[`PLEIAD_OPENCODE_${kind.toUpperCase()}_URL`];
  if (!base || !SECRET) throw new Error('Pleiad relay is unavailable');
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Invalid Pleiad relay address');
  url.searchParams.set('account', ACCOUNT);
  url.searchParams.set('session', session);
  if (context) url.searchParams.set('kind', 'context');
  return url;
}
async function call(kind, session, body, context = false) {
  const until = Date.now() + 60000;
  for (;;) {
    let response;
    try {
      // Resolve on every attempt: Pleiad may have moved while this CLI stayed alive.
      response = await fetch(endpoint(kind, session, context), {
        method: body ? 'POST' : 'GET',
        headers: {authorization: 'Bearer ' + SECRET, ...(body ? {'content-type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
    } catch {
      if (Date.now() >= until) throw new Error('Pleiad relay connection failed');
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    if (!response.ok) throw new Error('Pleiad relay rejected this conversation');
    return response.json();
  }
}

export default {
  id: 'pleiad',
  async setup(ctx) {
    const registrations = [];
    registrations.push(await ctx.session.hook('prompt', async event => {
      try {
        const context = await call('env',event.sessionID,undefined,true);
        const required = context.requiredServers ?? [];
        const until = Date.now()+30000;
        while(required.length && Date.now()<until) {
          const tools = await ctx.tool.list();
          if(required.every(name=>tools.some(tool=>tool.options?.namespace===name)))break;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
      } catch { /* Discovery errors are enforced at tool admission. */ }
    }));
    registrations.push(await ctx.shell.hook('create.before', event => {
      for (const key of Object.keys(event.env)) {
        if (/^PLEIAD_OPENCODE_/i.test(key) || /^OPENCODE_(SERVER_)?PASSWORD$/i.test(key)) delete event.env[key];
      }
    }));
    registrations.push(await ctx.tool.hook('execute.before', async event => {
      const verdict = await call('hook', event.sessionID, {session: event.sessionID, phase: 'before', tool: event.tool, args: event.input ?? {}});
      if (verdict?.block || verdict?.error) throw new Error(String(verdict.block ?? verdict.error));
      if (verdict?.args && typeof verdict.args === 'object') event.input = verdict.args;
    }));
    registrations.push(await ctx.tool.hook('execute.after', async event => {
      try {
        const output = event.status === 'completed' ? (event.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n') : String(event.error?.message ?? '');
        const verdict = await call('hook', event.sessionID, {session: event.sessionID, phase: 'after', tool: event.tool, args: event.input ?? {}, output});
        if (verdict?.append && event.status === 'completed') event.result = {...event.result, content: [...event.result.content, {type: 'text', text: String(verdict.append)}]};
      } catch { /* A completed tool must survive a late auxiliary callback. */ }
    }));
    for (const name of ['context', 'compaction', 'title', 'generate']) {
      registrations.push(await ctx.session.hook(name, async event => {
        try {
          const context = await call('env', event.sessionID, undefined, true);
          if (context.omitMessageIDs?.length) {
            const omitted = new Set(context.omitMessageIDs);
            event.messages = event.messages.filter(message => !omitted.has(message.id));
          }
          if (context.system) event.system.push({type: 'text', text: context.system});
        } catch { /* Auxiliary hooks cannot fail in the v2 plugin contract. */ }
      }));
    }
    return async () => { for (const registration of registrations) await registration.dispose(); };
  },
};
