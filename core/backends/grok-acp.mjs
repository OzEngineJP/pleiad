import { AcpClient } from './acp-client.mjs';
import { cliCommand } from '../cli-installation.mjs';

export const MAX_GROK_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Grok（`grok agent stdio`）の ACP の口。共通の実装は core/backends/acp-client.mjs で、ここは Grok 固有の差だけ:
 *   固有の通知（`_x.ai/session_notification`・`_x.ai/session/interjection`）の振り分け・上限を超えた行を捨てたときの知らせ（onDrop。改行が届いた時点）
 * args: `grok agent` と `stdio` の間に入れるオプション（--model・--reasoning-effort）
 * held: 保持役の子に載せた CLI の口（core/backends/acp-held.mjs）。adopt: 付け直し（{ promptId }。initialize を送らない）
 */
export class GrokAcp extends AcpClient {
  constructor({ command = cliCommand('grok'), args = [], cwd, env, onUpdate = () => {}, onInterjection = () => {}, onResponse = () => {}, onRequest, onGone = () => {}, onDrop = ({ bytes }) => console.error(`  grok: dropped an oversize ACP line (${bytes} bytes)`), timeoutMs = 30_000, held = null, adopt = null } = {}) {
    super({
      label: 'Grok',
      args: ['agent', ...args, 'stdio'],
      command, cwd, env, timeoutMs, held, adopt,
      onUpdate, onResponse, onRequest, onGone,
      onDrop,
      maxFrameBytes: MAX_GROK_FRAME_BYTES,
      routeNotification: (method, params, opts, run) => {
        // Grok は固有の出来事を `_x.ai/session_notification`（内側は同じ sessionUpdate の形）で送る
        if (method === '_x.ai/session_notification') run(() => this.onUpdate(params, opts), 'update');
        // `_x.ai/interject` を受理した合図（session の流れへ入ったエコー。{ sessionId, text, interjectionId }）
        if (method === '_x.ai/session/interjection') run(() => this.onInterjection?.(params, opts), 'update');
      },
    });
    this.args = args;
    this.onInterjection = onInterjection;
  }
}
