// The v2 plugin is a directory package, independent of Pleiad's asar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const PLUGIN_FILE = 'index.js';
export const PLUGIN_SOURCE = fs.readFileSync(new URL('./opencode-plugin-source.mjs', import.meta.url), 'utf8');
export function writePlugin(dataDir) {
  const dir = path.join(dataDir, 'opencode', 'pleiad-plugin-v2');
  fs.mkdirSync(dir, { recursive: true });
  const files = { 'package.json': JSON.stringify({name:'pleiad-opencode',version:'2.0.0',type:'module',main:'index.js'}), [PLUGIN_FILE]: PLUGIN_SOURCE };
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir,name);
    let current;try {current=fs.readFileSync(file,'utf8');}catch{}
    if(current!==body)fs.writeFileSync(file,body);
  }
  return pathToFileURL(dir).href;
}

export function writeRelayConfig(dataDir, account, relay) {
  const dir = path.join(dataDir, 'run');
  fs.mkdirSync(dir, {recursive:true});
  const file = path.join(dir, 'opencode-relay-' + crypto.createHash('sha256').update(account).digest('hex').slice(0,24) + '.json');
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(relay), {mode:0o600});
  fs.renameSync(tmp,file);
  return file;
}
