import { registerHooks } from 'node:module';

const fakeModule = new URL('../../core/backends/fake.mjs', import.meta.url).href;
const source = `import { backend as fake } from ${JSON.stringify(fakeModule)};
export const backend = { ...fake, id: 'pleiad-agent', label: 'Pleiad Agent' };`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './pleiad-agent.mjs' && context.parentURL?.endsWith('/core/backends/index.mjs')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

await import('../../core/server.mjs');

// Simulate code mutating the process environment after startup, and an old
// conversation left by an unmanaged host.
delete process.env.AGENT_HOST_KIND;
const store = await import('../../core/store.mjs');
await store.setMeta('managed-test-old-session', { backend: 'fake' });
