import { backend } from '../../core/backends/fake.mjs';

// 設定の検証だけを一度止める。後から来る送信側のモデル取得は通す。
const models = backend.models.bind(backend);
let armed = false;
backend.models = async (...args) => {
  if (armed) {
    armed = false;
    const release = new Promise(resolve => process.once('message', resolve));
    process.send('modelsHeld');
    await release;
  }
  return models(...args);
};
process.on('message', (message) => {
  if (message !== 'holdModels') return;
  armed = true;
  process.send('modelsArmed');
});

await import('../../core/server.mjs');
