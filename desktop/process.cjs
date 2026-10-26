// Electron main の側のプロセスの口（ADR 0270 の規則 ①。docs/adr/0270-server-may-die-anytime.md）。
// main が子を起こす API はここだけ（tests/lint-child-process.mjs が数える）。今は utilityProcess.fork だけ。
// サーバーを main の子でない形（detached の pleiad-node.exe）で起こすのは desktop/server-boot.cjs（core/process.mjs の detach と同じ形）。
const { utilityProcess } = require('electron');

/** utilityProcess を起こす。options は utilityProcess.fork と同じ */
function forkUtility(modulePath, args = [], options = {}) {
  return utilityProcess.fork(modulePath, args, options);
}

module.exports = { forkUtility };
