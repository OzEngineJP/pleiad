// ファイルのページと隔離の origin のリスナーの共通の土台（ADR 0295 の 1）。core/pages-server.mjs・core/isolated-server.mjs が使う。
//   - 127.0.0.1 と ::1 の同じ port に bind する（Chrome は localhost を ::1 から試すことがある）。AGENT_HOST_BIND で本体を LAN に開いていても、ここはループバックだけ
//   - Host が localhost:<その port> のときだけ答える（DNS rebinding を防ぐ。違えば 421）。受けるのは GET と HEAD だけ（ほかは 405）
//   - どの応答にも Referrer-Policy: no-referrer と X-Content-Type-Options: nosniff を付ける
//   - 覚えた port が塞がっていれば waitMs まで待ち（無停止の更新で前のサーバーが放すのを待つ）、それでも取れなければ空いた port にする
import http from 'node:http';

export const LOOPBACK = Object.freeze(['127.0.0.1', '::1']);
export const COMMON_HEADERS = Object.freeze({ 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
const BUSY = ['EADDRINUSE', 'EACCES'];
// IPv6 の無い PC。127.0.0.1 だけで待つ
const NO_IPV6 = ['EADDRNOTAVAIL', 'EAFNOSUPPORT'];
const FRESH_TRIES = 5;

/** Host の見出しが localhost:<port> と同じか（大小文字は見ない） */
export function hostOk(header, port) {
  return typeof header === 'string' && header.toLowerCase() === `localhost:${port}`;
}

/** 本文の短い応答（404・401 など）。HEAD には本文を付けない */
export function sendStatus(req, res, status, text = '') {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : text);
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', bound); reject(error); };
    const bound = () => { server.off('error', failed); resolve(server.address().port); };
    server.once('error', failed);
    server.once('listening', bound);
    server.listen(port, host);
  });
}

function closeAll(servers) {
  return Promise.all(servers.map(server => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
}

/**
 * リスナーを立てる。
 * @param {object} options
 * @param {string} options.name                     ログの名前（pages・isolated）
 * @param {number} [options.port]                   試す port（0 なら空いた port）
 * @param {number} [options.waitMs]                 塞がっていたら待つ上限
 * @param {number} [options.retryMs]                待つ間の試し直しの間隔
 * @param {(req, res, { url }) => any} options.handle Host・メソッドを通った要求（共通のヘッダーは付けてある）
 * @param {string[]} [options.hosts]                bind する先（試験用。既定は 127.0.0.1 と ::1）
 * @param {(header: string|undefined, port: number) => boolean} [options.hostCheck]
 *        Host の見出しの検査（既定は localhost:<port> と同じ。隔離のリスナーは <印>.localhost:<port> も通す。core/isolated-origins.mjs）
 * @returns {Promise<{ port: number, hosts: string[], close: () => Promise<void> }>}
 */
export async function startPageListener({ name, port: wanted = 0, waitMs = 0, retryMs = 40, handle, hosts = LOOPBACK, hostCheck = hostOk, log = () => {}, now = Date.now }) {
  let boundPort = 0;
  const onRequest = (req, res) => {
    for (const [key, value] of Object.entries(COMMON_HEADERS)) res.setHeader(key, value);
    // Host は HTTP/1.1 で 1 つだけ。2 つ来たとき node は先頭を取るが、どれを採ったか分からないまま通さない
    const hostHeaders = req.rawHeaders.filter(header => header.toLowerCase() === 'host');
    if (hostHeaders.length !== 1 || !hostCheck(req.headers.host, boundPort)) return sendStatus(req, res, 421, 'misdirected request');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendStatus(req, res, 405, 'method not allowed');
    }
    let url;
    try { url = new URL(req.url, `http://localhost:${boundPort}`); } catch { return sendStatus(req, res, 400, 'bad request'); }
    Promise.resolve().then(() => handle(req, res, { url })).catch(error => {
      log(`${name}: request failed: ${String(error?.message ?? error)}`);
      sendStatus(req, res, 500, 'internal error');
    });
  };

  const attempt = async port => {
    const servers = [], bound = [];
    try {
      for (const host of hosts) {
        const server = http.createServer(onRequest);
        servers.push(server);
        try {
          port = await listenOn(server, port, host);
          bound.push(host);
        } catch (error) {
          // 1 つ目が立った後の IPv6 の無い PC は、立った分で待つ
          if (bound.length && NO_IPV6.includes(error?.code)) { servers.pop(); log(`${name}: ${host} is not available (${error.code})`); continue; }
          throw error;
        }
      }
      return { port, servers, bound };
    } catch (error) {
      await closeAll(servers);
      throw error;
    }
  };

  const deadline = now() + Math.max(0, waitMs);
  let port = wanted, waited = false, fresh = 0;
  for (;;) {
    try {
      const { port: got, servers, bound } = await attempt(port);
      boundPort = got;
      if (waited) log(`${name}: took port ${got} after waiting`);
      return { port: got, hosts: bound, close: () => closeAll(servers) };
    } catch (error) {
      if (!BUSY.includes(error?.code)) throw error;
      if (port !== 0 && now() < deadline) {
        waited = true;
        await new Promise(resolve => setTimeout(resolve, retryMs));
        continue;
      }
      if (port !== 0) {
        log(`${name}: port ${port} is not available (${error.code}); using a free port`);
        port = 0;
        continue;
      }
      // 空いた port で 127.0.0.1 は取れたが ::1 の同じ番号が塞がっていた。番号を変えて試し直す
      if (++fresh >= FRESH_TRIES) throw error;
    }
  }
}
