import { createHash } from 'node:crypto';
import { normalizeModels } from '../compat-endpoints.mjs';
import { t } from '../i18n.mjs';
import { managedBackendIds } from './host-policy.mjs';

export const chatGptEndpoint = id => typeof id === 'string' && /^chatgpt-[0-9a-f]{32}$/.test(id);
const endpointId = id => 'chatgpt-' + createHash('sha256').update(id).digest('hex').slice(0, 32);

export function createChatGptConnections(load) {
  let pending;
  const adapter = async () => {
    if (managedBackendIds) throw new Error(t('chatgpt.localOnly'));
    return load();
  };

  return {
    async list() {
      if (managedBackendIds) return [];
      const bridge = await adapter().catch(() => null);
      if (!bridge) return [];
      const { accounts } = await bridge.chatGptSession.status({ cwd: process.cwd() }).catch(() => ({ accounts: [] }));
      return accounts.map((account, i) => {
        const { ids, info } = normalizeModels(account.models);
        return {
          id: endpointId(account.id), agent: 'pleiad-agent', kind: 'chatgpt-plan',
          name: `ChatGPT ${i + 1}`, baseUrl: 'https://api.openai.com/v1',
          limited: account.limited,
          ready: account.connected && account.planEnabled && !account.limited && ids.length > 0,
          models: ids, modelInfo: info, roles: { main: ids[0] ?? '' }, options: {},
        };
      });
    },
    async resolve(id) {
      const bridge = await adapter();
      const { accounts } = await bridge.chatGptSession.status();
      const account = accounts.find(row => endpointId(row.id) === id);
      if (!account) throw new Error(t('chatgpt.signInRequired'));
      if (account.limited) throw new Error(t('chatgpt.limitTurn'));
      if (!account.connected || !account.planEnabled) throw new Error(t('chatgpt.signInRequired'));
      const { ids, info } = normalizeModels(account.models);
      if (!ids.length) throw new Error(t('chatgpt.refreshRequired'));
      return { id, agent: 'pleiad-agent', kind: 'chatgpt-plan', registration: account.id,
        models: ids, modelInfo: info, roles: { main: ids[0] } };
    },
    async command(action, args, signal) {
      const bridge = await adapter();
      const session = bridge.chatGptSession;
      const status = async () => {
        const state = await session.status({ cwd: process.cwd() });
        return { ...state, accounts: state.accounts.map(row => ({ ...row, endpointId: endpointId(row.id) })) };
      };
      if (action === 'status') return { ...await status(), pending: Boolean(pending) };
      if (action === 'cancel') {
        pending?.abort();
        return { ...await status(), pending: false };
      }
      if (action === 'login') {
        if (pending) throw new Error(t('chatgpt.pending'));
        const controller = new AbortController();
        pending = controller;
        try {
          const loginSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          const account = await session.login({ id: args.id, consent: args.consent === true,
            openBrowser: bridge.openChatGptBrowser, signal: loginSignal });
          let note;
          if (account.planEnabled) {
            try { await bridge.listChatGptModels({ id: account.id, signal: loginSignal }); }
            catch { note = 'chatgpt.refreshRequired'; }
          }
          return { ...await status(), firstSignIn: account.firstSignIn, note, pending: false };
        } finally {
          pending = null;
        }
      }
      if (typeof args.id !== 'string' || !args.id) throw new Error(t('chatgpt.signInRequired'));
      let note;
      if (action === 'logout') {
        const { revoked } = await session.logout(args.id);
        if (!revoked) note = 'chatgpt.revokeUnconfirmed';
      } else if (action === 'models') {
        await bridge.listChatGptModels({ id: args.id, signal });
      } else if (action === 'resume') {
        await session.resumeUsage(args.id);
      } else {
        throw new Error(t('chatgpt.actionInvalid'));
      }
      return { ...await status(), note, pending: Boolean(pending) };
    },
  };
}
