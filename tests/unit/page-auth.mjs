// Pleiad のページの 2 つの入口の認証（core/page-auth.mjs）と旗（core/browser-unify-flag.mjs）。純粋な関数だけを見る。
import crypto from 'node:crypto';
import {
  MAIN_COOKIE, PAGES_COOKIE, PAGES_PATH, mainCookieOk, pageRequestOk, pagesCookie, pagesCookieOk, pagesSecret, readCookies, sameSecret,
} from '../../core/page-auth.mjs';
import { BROWSER_UNIFY_ENV, browserUnifyOn } from '../../core/browser-unify-flag.mjs';

export const name = 'page-auth';
export const title = 'ページの入口の認証（ページの Cookie・本体の Cookie・?token= を受けない）と旗の読み方';

export default async function (t) {
  const token = 'tok-' + crypto.randomBytes(8).toString('hex');
  const secret = pagesSecret(token);

  t.ok('ページの Cookie の値は HMAC-SHA256(本体のトークン, "pleiad-pages") の 16 進で、トークンそのものではない',
    secret === crypto.createHmac('sha256', token).update('pleiad-pages').digest('hex') && secret !== token && !secret.includes(token));
  t.ok('同じトークンなら同じ値・違うトークンなら違う値', pagesSecret(token) === secret && pagesSecret(token + 'x') !== secret);

  const cookie = pagesCookie(token);
  t.ok('置く Cookie は Path=/_pleiad/・HttpOnly・SameSite=Strict', cookie.name === PAGES_COOKIE && cookie.value === secret
    && cookie.path === PAGES_PATH && cookie.httpOnly === true && cookie.sameSite === 'Strict' && PAGES_PATH === '/_pleiad/');

  t.ok('Cookie の見出しから同じ名前の値を全部読み、壊れた % は捨てる',
    JSON.stringify(readCookies(`a=1; ${PAGES_COOKIE}=x; ${PAGES_COOKIE}=%E3%81%82; ${PAGES_COOKIE}=%zz;b=2`, PAGES_COOKIE)) === JSON.stringify(['x', 'あ'])
    && readCookies(undefined, PAGES_COOKIE).length === 0 && readCookies('noequals', 'noequals').length === 0);

  t.ok('比べるのは長さと中身が同じときだけ・空の期待値や文字列でないものは通さない',
    sameSecret('abc', 'abc') && !sameSecret('abc', 'abd') && !sameSecret('ab', 'abc') && !sameSecret('', '') && !sameSecret(undefined, 'abc') && !sameSecret(123, '123'));

  t.ok('ページの入口: ページの Cookie のどれかが合えば通す（Path の違う古い値が前に並んでも）',
    pagesCookieOk(`${PAGES_COOKIE}=${secret}`, token) && pagesCookieOk(`${PAGES_COOKIE}=old; ${PAGES_COOKIE}=${secret}`, token));
  t.ok('ページの入口: 本体の Cookie・トークンそのもの・トークンが空では通さない',
    !pagesCookieOk(`${MAIN_COOKIE}=${token}`, token) && !pagesCookieOk(`${PAGES_COOKIE}=${token}`, token)
    && !pagesCookieOk(`${PAGES_COOKIE}=${pagesSecret('')}`, '') && !pagesCookieOk('', token));

  t.ok('本体の入口: 本体の Cookie が合えば通し、ページの Cookie・違う値は通さない',
    mainCookieOk(`${MAIN_COOKIE}=${token}`, token) && !mainCookieOk(`${PAGES_COOKIE}=${secret}`, token)
    && !mainCookieOk(`${MAIN_COOKIE}=${token}x`, token) && !mainCookieOk(`${MAIN_COOKIE}=`, ''));

  t.ok('入口ごとに見る Cookie が違い、知らない入口は通さない（?token= は見出しに無いので通らない）',
    pageRequestOk({ via: 'pages', cookie: `${PAGES_COOKIE}=${secret}`, token })
    && !pageRequestOk({ via: 'pages', cookie: `${MAIN_COOKIE}=${token}`, token })
    && pageRequestOk({ via: 'main', cookie: `${MAIN_COOKIE}=${token}`, token })
    && !pageRequestOk({ via: 'main', cookie: `${PAGES_COOKIE}=${secret}`, token })
    && !pageRequestOk({ via: 'main', cookie: undefined, token })
    && !pageRequestOk({ via: 'other', cookie: `${MAIN_COOKIE}=${token}; ${PAGES_COOKIE}=${secret}`, token }));

  t.ok('旗は AGENT_HOST_BROWSER_UNIFY が on のときだけ（前後の空白・大小文字は見ない）',
    BROWSER_UNIFY_ENV === 'AGENT_HOST_BROWSER_UNIFY'
    && browserUnifyOn({ AGENT_HOST_BROWSER_UNIFY: 'on' }) && browserUnifyOn({ AGENT_HOST_BROWSER_UNIFY: ' ON ' })
    && !browserUnifyOn({}) && !browserUnifyOn({ AGENT_HOST_BROWSER_UNIFY: '' }) && !browserUnifyOn({ AGENT_HOST_BROWSER_UNIFY: '1' })
    && !browserUnifyOn({ AGENT_HOST_BROWSER_UNIFY: 'off' }) && !browserUnifyOn({ AGENT_HOST_BROWSER_UNIFY: 'true' }));
}
