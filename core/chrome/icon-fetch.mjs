// タブの favicon を中継のプロセスが取りに行く HTTP（core/chrome/tab-info.mjs。ADR 0294）。
// ページは favicon の URL を好きに書けるので、そのまま取りに行くと、手元やネットワークの中のアドレス
// （loopback・private・link-local・この PC の別のアドレス・Pleiad の port）へ中継から要求を出せてしまう。
// ここでは名前を解決した後の IP を検査し、検査した IP へそのまま繋ぐ（解決し直さないので、DNS の付け替えでも抜けられない）。
// リダイレクトは追わない（呼ぶ側が 1 回ずつここを通す）。環境変数のプロキシは使わない。
//
// CDP で Chrome が読み込み済みの画像を取る形にしなかった理由: favicon はブラウザーのプロセスが読むので、
// ページの資源（Page.getResourceContent）に出ない。Network.loadNetworkResource は includeCredentials:false でも
// same-origin の資格で送り、Cookie が付く（A5 が Chrome 156 で確かめた）。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns';
import { Readable } from 'node:stream';

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

/** IPv6 の中に IPv4 を埋めた形（::ffff:a.b.c.d・NAT64 の 64:ff9b::/96・6to4 の 2002::/16）なら、その IPv4 */
function embeddedIpv4(address) {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const groups = expandIpv6(lower);
  if (!groups) return null;
  const v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return null;
}

function expandIpv6(address) {
  if (net.isIPv6(address) !== true) return null;
  let text = address;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [], right = rest === undefined ? [] : (rest ? rest.split(':') : []);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(fill).fill('0'), ...right].map(g => parseInt(g, 16));
}

/** この PC のネットワークのアドレス（公開の IP を持つ PC でも、0.0.0.0 で待つ手元のサーバーへ届かないように） */
function ownAddresses() {
  const own = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const entry of list ?? []) own.add(entry.address.toLowerCase().split('%')[0]);
  return own;
}

/** 中継が繋いでよい公開のアドレスか（private・loopback・link-local・文書用・マルチキャスト・この PC のアドレスは断る） */
export function publicAddress(address, own = ownAddresses()) {
  const text = String(address ?? '').toLowerCase().split('%')[0];
  const family = net.isIP(text);
  if (!family || own.has(text)) return false;
  if (family === 4) return !blocked.check(text, 'ipv4');
  const v4 = embeddedIpv4(text);
  if (v4) return !own.has(v4) && !blocked.check(v4, 'ipv4');
  return !blocked.check(text, 'ipv6');
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * fetch に似た形（呼ぶ側の tab-info.mjs と試験の差し替えと同じ形）で 1 回だけ GET する。
 * @param {object} [deps]
 * @param [deps.lookup] (hostname) => Promise<{ address, family }[]>（試験用）
 * @returns (url, { signal, local }) => Promise<Response>。local が真なら（ページと同じ localhost・IP の直書きの宛先）アドレスを検査しない
 */
export function createIconFetch({ lookup = hostname => dns.promises.lookup(hostname, { all: true, verbatim: true }) } = {}) {
  return async function iconFetch(href, { signal, local = false } = {}) {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname);
    const own = ownAddresses();
    const usable = addresses.filter(entry => local || publicAddress(entry.address, own));
    // 1 つでも公開でないアドレスが混ざる名前は断る（どれに繋ぐかで結果が変わる名前を使わない）
    if (!usable.length || (!local && usable.length !== addresses.length)) throw new Error('blocked address');
    const { address, family } = usable[0];
    const client = url.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
      const req = client.request({
        host: address, family, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: `${url.pathname}${url.search}`,
        method: 'GET', agent: false, signal, servername: net.isIP(hostname) ? undefined : hostname,
        headers: { host: url.host, accept: 'image/*', 'user-agent': 'Pleiad' },
      }, res => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const one of [value].flat()) if (one !== undefined) headers.append(name, String(one));
        const status = res.statusCode ?? 502;
        if (NULL_BODY.has(status) || status < 200 || status > 599) { res.resume(); return resolve(new Response(null, { status: status < 200 || status > 599 ? 502 : status, headers })); }
        resolve(new Response(Readable.toWeb(res), { status, headers }));
      });
      req.on('error', reject);
      req.end();
    });
  };
}
