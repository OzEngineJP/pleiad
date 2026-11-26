import { acpTurnLimit } from './acp-error.mjs';
import { AcpClient } from './acp-client.mjs';
import { cliCommand } from '../cli-installation.mjs';

export const MAX_DEVIN_FRAME_BYTES = 64 * 1024 * 1024;

/** Cognition 固有の構造化種別（data['cognition.ai/errorKind']）。文面に無い日次クォータ枯渇を usageExhausted にする（core/backends/acp-error.mjs の vendorKinds） */
export const COGNITION_VENDOR_KINDS = Object.freeze({ 'cognition.ai/errorKind': Object.freeze({ resource_exhausted: 'usageExhausted' }) });

/**
 * Devin（`devin acp`）の ACP の口。共通の実装は core/backends/acp-client.mjs で、ここは Devin 固有の差だけ:
 *   session/update 以外の通知（_cognition.ai/compaction などの ext_notification）を onNotification へ・
 *   断られた依頼に載せる安全な印（acpLimit・configRejected）・上限を超えた行の知らせ（onOverflow。改行を待たずに分かる）
 * held: 保持役の子に載せた CLI の口（core/backends/acp-held.mjs の createHeldAcp）。無ければ今の形（spawnCli）
 * adopt: 付け直し（{ promptId }。走っている session/prompt の応答を拾い直す）。initialize も session の作成も送らない
 */
export class DevinAcp extends AcpClient {
  constructor({ command = cliCommand('devin'), cwd, env, onUpdate = () => {}, onNotification = () => {}, onResponse = () => {}, onRequest, onGone = () => {}, onDrop = ({ bytes }) => console.error(`  devin: dropped an oversize ACP line (${bytes} bytes)`), timeoutMs = 30_000, held = null, adopt = null } = {}) {
    super({
      label: 'Devin',
      args: ['acp'],
      command, cwd, env, timeoutMs, held, adopt,
      onUpdate, onResponse, onRequest, onGone,
      onOverflow: onDrop,
      maxFrameBytes: MAX_DEVIN_FRAME_BYTES,
      vendorKinds: COGNITION_VENDOR_KINDS,
      // session/update 以外の通知。要求（id 付き）は基底が処理する
      routeNotification: (method, params, opts) => this.onNotification(method, params, opts),
      decorateError: (reject, { error, method, params }) => {
        // 構造化した安全な印だけを載せる（wire の message/data/trace id はここから外へ出さない）
        const limit = acpTurnLimit(error);
        if (limit) reject.acpLimit = limit;
        // 設定の値を CLI が断った印（-32602 Invalid params）。どの設定か（configId）だけを載せ、
        // モデル・思考の強さの断りを kind: 'model' の失敗として扱わせる（ADR 0356）
        if (error.code === -32602 && method === 'session/set_config_option' && typeof params?.configId === 'string') {
          reject.configRejected = { option: params.configId };
        }
      },
    });
    this.onNotification = onNotification;
  }
}
