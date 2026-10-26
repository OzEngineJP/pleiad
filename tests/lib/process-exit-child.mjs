import assert from 'node:assert/strict';
import { onExit } from '../../core/process.mjs';

const before = process.listenerCount('exit');
const canceled = Array.from({ length: 20 }, () => onExit(() => { throw new Error('canceled cleanup ran'); }));
assert.equal(process.listenerCount('exit'), before + 1);
for (const off of canceled) { off(); off(); }
assert.equal(process.listenerCount('exit'), before);

const seen = [];
const active = Array.from({ length: 20 }, (_, i) => onExit(code => seen.push([i, code])));
active[5]();
onExit(code => console.log(JSON.stringify({ code, seen })));
assert.equal(process.listenerCount('exit'), before + 1);
process.exitCode = 7;
