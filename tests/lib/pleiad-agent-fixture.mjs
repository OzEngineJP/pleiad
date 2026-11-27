import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function startPleiadAgentFixture(options, { packagedRoot } = {}) {
  const cli = packagedRoot
    ? createRequire(path.join(packagedRoot, 'package.json')).resolve('pleiad-agent/cli')
    : process.env.AGENT_HOST_PLEIAD_AGENT_BIN || require.resolve('pleiad-agent/cli');
  const fixture = path.resolve(path.dirname(cli), 'adapters/stdio/fixtures/model.mjs');
  const { startScriptedModel } = await import(pathToFileURL(fixture).href);
  const model = await startScriptedModel(options);
  return {
    model,
    close: model.close,
    env: {
      AGENT_HOST_BACKENDS: 'pleiad-agent',
      AGENT_HOST_PLEIAD_AGENT_BIN: packagedRoot ? '' : cli,
      AGENT_HOST_PLEIAD_AGENT_PROVIDER: 'openai',
      AGENT_HOST_PLEIAD_AGENT_MODEL: 'fixture',
      AGENT_HOST_PLEIAD_AGENT_BASE_URL: model.baseUrl,
      AGENT_HOST_PLEIAD_AGENT_KEY_ID: '',
      AGENT_HOST_PLEIAD_AGENT_API_KEY: options?.token ?? '',
    },
  };
}
