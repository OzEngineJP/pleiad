// 試験の中継に差し込む「公式の中継」の認可（relay/server.mjs の authz。docs/remote.md §5.7）。
// 本物の中継はデプロイされていないので、試験はこの差し込みで確かめる:
//   host(ctx)   /v1/host と /v1/host/accept。X-Pleiad-Account の ID トークンを確かめ、
//               uid がその hostId の登録主なら通す（tags に u:<uid> と h:<hostId>）
//   device(ctx) /v1/device と /v1/device/notify。ペアリングは受けない（4401 'pairing disabled'）。
//               deviceId の無いものは通して admit: true を返す（トークンとアカウントは確かめる）。
//               deviceId のあるものはトークンの照合を中継に任せて通す（どちらも uid の確かめはする）
//
// state.blockHosts / state.blockDevices に { code, reason } を置くと、その判定を強制的に返す
// （4401 'account'・4429 'account limit'・1013 相当の試験に使う）。
// state.looseDevices = true の間は device の uid と hostId の持ち主の照合を飛ばす
// （ほかのアカウントの端末をホストまで届けて、ホスト側の denied 'account' を確かめる）。
// attach() で受けた handle は authz.handle に残る（closeTag で接続を切る試験に使う）。
export function createPlusRelayAuthz({ verify, isBound }) {
  const state = { blockHosts: null, blockDevices: null, looseDevices: false };
  const authz = {
    state,
    handle: null,
    async host(ctx) {
      if (state.blockHosts) return { ok: false, ...state.blockHosts };
      let uid;
      try { uid = (await verify(ctx.headers['x-pleiad-account'])).uid; }
      catch { return { ok: false, code: 4401, reason: 'token' }; }
      if (!(await isBound(uid, ctx.hostId))) return { ok: false, code: 4401, reason: 'account' };
      return { ok: true, tags: [`u:${uid}`, `h:${ctx.hostId}`] };
    },
    async device(ctx) {
      if (state.blockDevices) return { ok: false, ...state.blockDevices };
      if (ctx.pairing) return { ok: false, code: 4401, reason: 'pairing disabled' };
      let uid;
      try { uid = (await verify(ctx.headers['x-pleiad-account'])).uid; }
      catch { return { ok: false, code: 4401, reason: 'token' }; }
      if (!state.looseDevices && !(await isBound(uid, ctx.hostId))) return { ok: false, code: 4401, reason: 'account' };
      if (ctx.deviceId == null) return { ok: true, tags: [`u:${uid}`], admit: true };
      return { ok: true, tags: [`u:${uid}`, `d:${ctx.deviceId}`] };
    },
    attach(handle) { authz.handle = handle; },
  };
  return authz;
}
