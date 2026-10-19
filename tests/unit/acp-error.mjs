import assert from 'node:assert/strict';
import { GrokAcp } from '../../core/backends/grok-acp.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { currentLocale, setLocale, t as translate } from '../../core/i18n.mjs';

export const name = 'acp-error';
export const title = 'ACP provider limits retain actionable reasons without exposing RPC secrets';

export default async function test(t) {
  const previousLocale = currentLocale();
  const secret = 'SYNTHETIC_ACP_SECRET';
  const cases = [
    [{ code: -32603, message: `API error (status 402 Payment Required): Grok Build usage balance exhausted ${secret}` }, 'usageExhausted'],
    [{ code: -32000, message: secret, data: { message: `insufficient_quota ${secret}` } }, 'usageExhausted'],
    [{ code: -32603, message: 'Internal error', data: `Grok Build usage balance exhausted ${secret}` }, 'usageExhausted'],
    [{ code: -32603, message: 'Internal error', data: { details: `Grok Build usage balance exhausted ${secret}` } }, 'usageExhausted'],
    [{ code: -32000, message: secret, data: { error: { message: `quota exceeded ${secret}` } } }, 'usageExhausted'],
    [{ code: -32000, message: `API error (status 402 Payment Required): ${secret}` }, 'paymentRequired'],
    [{ code: -32000, message: secret, data: { statusCode: 402 } }, 'paymentRequired'],
    [{ code: -32000, message: secret, data: { httpStatus: 402 } }, 'paymentRequired'],
    [{ code: -32000, message: `rate limit exceeded ${secret}` }, 'rateLimited'],
    [{ code: -32000, message: secret, data: { status: 429 } }, 'rateLimited'],
    [{ code: -32042, message: secret, data: { token: secret } }, null],
    [{ code: -32601, message: 'Method not found' }, null],
    [{ code: -32002, message: secret }, null],
    [{ code: 1e21, message: secret }, null],
  ];
  try {
    for (const locale of ['ja', 'en']) {
      setLocale(locale);
      for (const [Client, agent] of [[GrokAcp, 'Grok'], [DevinAcp, 'Devin']]) {
        const client = new Client({ timeoutMs: 0 });
        client.proc = { stdin: { writable: true, write() {} } };
        for (const [error, key] of cases) {
          const pending = client.call('session/prompt', { prompt: [{ type: 'text', text: secret }] });
          client.reader.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: `pleiad-${client.nextId}`, error }) + '\n'));
          await assert.rejects(pending, result => {
            assert.equal(result.message, key ? translate(`acp.errors.${key}`, { agent }) : `${agent} ACP request failed`);
            assert.equal(result.code, Number.isSafeInteger(error.code) ? error.code : -32000);
            assert.equal(Object.hasOwn(result, 'data'), false);
            assert.equal(result.message.includes(secret), false);
            assert.equal(JSON.stringify(result).includes(secret), false);
            return true;
          });
          assert.equal(client.pending.size, 0);
        }
        t.ok(`${agent} ${locale}: provider limits are localized and unknown failures stay private`, true);
      }
    }
  } finally { setLocale(previousLocale); }
}
