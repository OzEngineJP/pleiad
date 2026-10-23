// 登録アカウントの操作とログインの寿命。資格情報を返すのはバックエンドから台帳への一方向だけ。
import { t } from './i18n.mjs';

// removed(id) は登録を消した後に呼ぶ（server が委譲の段ごとの候補からそのアカウントを外す。ADR 0264）
export function createAgentAccountManager({ accounts, getBackend, emit, invalidate = () => {}, openExternal = async () => {}, removed = async () => {} }) {
  const logins = new Map();
  const backendOf = (id) => {
    const b = getBackend(id);
    if (b?.capabilities?.accounts !== 'agent') throw new Error(t('accounts.badBackend'));
    return b;
  };
  const entryOf = async (id) => {
    const row = await accounts.get(id);
    if (!row) throw new Error(t('accounts.notRegistered'));
    return row;
  };
  const changed = (backend) => { invalidate(); emit({ type: 'agentAccountsChanged', sessionId: null, backend }); };
  async function cancel(id, attempt) {
    const run = logins.get(id);
    if (!run || (attempt && attempt !== run.attempt)) return { cancelled: false };
    const cancelled = run.phase !== 'committing';
    if (cancelled) run.controller.abort();
    await run.promise.catch(() => {});
    return { cancelled };
  }
  return {
    async list({ backend }) {
      const b = backendOf(backend);
      const rows = await accounts.list(backend);
      return { accounts: await Promise.all(rows.map(async (row) => {
        const account = { ...(await accounts.get(row.id)), credential: await accounts.credential(row.id) };
        const status = await b.accountStatus({ account }).catch(() => null);
        return { ...row, hasCredential: row.hasCredential && status?.hasCredential !== false,
          ...(typeof status?.label === 'string' ? { label: status.label } : {}) };
      })) };
    },
    async create({ backend, name }) {
      backendOf(backend);
      const { id } = await accounts.create({ backend, name });
      changed(backend);
      return { id, backend, name: (await accounts.get(id)).name };
    },
    async rename({ id, name }) {
      const row = await entryOf(id);
      backendOf(row.backend);
      const result = await accounts.rename(id, name);
      changed(row.backend);
      return result;
    },
    async remove({ id }) {
      const row = await entryOf(id);
      const b = backendOf(row.backend);
      await cancel(id);
      await b.accountRemove?.({ account: { ...row, credential: await accounts.credential(id) } });
      await accounts.remove(id);
      await removed(id);
      changed(row.backend);
      return { id };
    },
    async login({ id, open = false, attempt }) {
      const row = await entryOf(id);
      const b = backendOf(row.backend);
      if (logins.has(id)) throw new Error(t('accounts.loginBusy'));
      const controller = new AbortController();
      const run = { controller, promise: null, attempt, phase: 'login' };
      logins.set(id, run);
      run.promise = (async () => {
        const account = { ...row, credential: await accounts.credential(id) };
        const result = await b.accountLogin({ account, signal: controller.signal,
          openExternal: open ? openExternal : async () => {},
          emit: (event) => {
            if (controller.signal.aborted || event?.type !== 'auth') return;
            const { phase, url, message } = event;
            emit({ type: 'auth', sessionId: null, backend: b.id, accountId: id, loginId: attempt, phase,
              ...(typeof url === 'string' ? { url } : {}), ...(typeof message === 'string' ? { message } : {}) });
          } });
        controller.signal.throwIfAborted();
        if (!result?.credential) throw new Error(t('accounts.loginFailed'));
        // ここからの保存は完了させる。取消は保存を待ち、cancelled:false を返す。
        run.phase = 'committing';
        await accounts.setCredential(id, result.credential);
        changed(b.id);
        return { id, ...(typeof result.label === 'string' ? { label: result.label } : {}) };
      })().finally(() => { if (logins.get(id) === run) logins.delete(id); });
      return run.promise;
    },
    cancel: ({ id, attempt }) => cancel(id, attempt),
    cancelAll: () => { for (const run of logins.values()) run.controller.abort(); },
  };
}
