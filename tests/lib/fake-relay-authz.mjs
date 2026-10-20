// tests/unit/relay-authz.mjs の RELAY_AUTHZ_MODULE の試験用。すべての判定を通す差し込み。
export function createAuthz() {
  return {
    async host() { return { ok: true, tags: ['example:a'] }; },
    async device() { return { ok: true, tags: ['example:a'] }; },
  };
}
