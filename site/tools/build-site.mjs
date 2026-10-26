// サイトを配る形に組む。日本語（site/index.html・site/download/index.html）を根に、英語（locales/en.json から作る）を en/ に置く。
// 訳す要素は data-i18n="キー"（中身を置き換える）・data-i18n-attr="属性:キー;…"（属性を置き換える）で付ける。
// 中身は locales/en.json の値（HTML）。{claude} {openai} {antigravity} は各ロゴの <img> に展開する。
// ダウンロードのリンクと版は、組むときに GitHub の Releases から取って焼き込む（data-release。下の「配布物」）。
// 使い方の文書（site/docs・Astro Starlight）は /docs/ に組む（下の「文書」）。
//
//     node site/tools/build-site.mjs [--out <出力先>] [--offline] [--no-install]
//       --offline      GitHub を引かない（文書も作業ツリーの core/ から作る）
//       --no-install   site/docs の依存（node_modules）が無くても npm ci しない
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DOCS_INDEX_FILE, DOCS_SNAPSHOT_FILE, DOCS_SOURCE_FILES } from "./docs-sources.mjs";

// 公開先の URL（canonical・hreflang・og:url・og:image の元）。末尾は /
export const SITE_URL = "https://pleiad.dev/";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = {
  ja: { dir: "", locale: "ja_JP", ogImage: "assets/og.png" },
  en: { dir: "en/", locale: "en_US", ogImage: "assets/og-en.png" },
};
// 辞書で訳すページ。src は site/ からの正本（日本語）、path は公開先のパス（日本語は根、英語は en/ の下）
export const PAGES = [
  { src: "index.html", path: "" },
  { src: "download/index.html", path: "download/" },
  { src: "plus/index.html", path: "plus/" },
];
// 出力先へ写さないもの（生成の材料）
const SKIP = new Set(["tools", "locales", "docs", "README.md", "index.html", "download", "plus", "wrangler.jsonc"]);
const LOGOS = {
  claude: '<img src="assets/claude.svg" alt="" width="16" height="16">',
  openai: '<img src="assets/openai.svg" alt="" width="16" height="16">',
  antigravity: '<img src="assets/antigravity.svg" alt="" width="16" height="16">',
};

const escText = (s) => s.replace(/&(?!#?\w+;)/g, "&amp;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// 開きタグ。属性の値の中の > は数えない
const OPEN_TAG = /<([a-zA-Z][\w:-]*)((?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?)>/g;

/** name の閉じタグの直前の位置と、閉じタグの終わりを返す（同じ名前の入れ子を数える） */
function findClose(html, name, from) {
  const re = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (!depth) return { start: m.index, end: re.lastIndex };
  }
  throw new Error(`<${name}> の閉じタグが見つからない（${html.slice(from - 80, from)}）`);
}

function setAttr(attrs, name, value) {
  const re = new RegExp(`(\\s${name}=)"[^"]*"`);
  return re.test(attrs) ? attrs.replace(re, `$1"${escAttr(value)}"`) : `${attrs} ${name}="${escAttr(value)}"`;
}

/**
 * 印の付いた開きタグを順に渡し、属性と中身を差し替える。
 * edit(name, attrs) は { attrs, content }（content が null なら中身はそのまま）を返す
 */
function rewriteTags(html, marker, edit) {
  let out = "";
  let pos = 0;
  OPEN_TAG.lastIndex = 0;
  for (let m; (m = OPEN_TAG.exec(html)); ) {
    const [, name, attrs = ""] = m;
    if (!marker.test(attrs)) continue;
    const r = edit(name, attrs);
    out += html.slice(pos, m.index) + `<${name}${r.attrs}>`;
    pos = OPEN_TAG.lastIndex;
    if (r.content != null) {
      const close = findClose(html, name, pos);
      out += r.content;
      pos = close.start;
      OPEN_TAG.lastIndex = close.start;
    }
  }
  return out + html.slice(pos);
}

/** data-i18n 系の属性を解いて、辞書があれば置き換える。dict が null なら（日本語）属性を外すだけ */
export function localize(html, dict) {
  return rewriteTags(html, /\sdata-i18n(-attr|-json)?=/, (name, attrs) => {
    const key = attrs.match(/\sdata-i18n="([^"]+)"/)?.[1];
    const attrMap = attrs.match(/\sdata-i18n-attr="([^"]+)"/)?.[1];
    const json = attrs.match(/\sdata-i18n-json="([^"]+)"/)?.[1];
    attrs = attrs.replace(/\sdata-i18n(-attr|-json)?="[^"]*"/g, "");
    let content = null;
    if (dict) {
      if (attrMap) {
        for (const pair of attrMap.split(";")) {
          const [attr, k] = pair.split(":");
          if (dict[k] == null) throw new Error(`辞書に無いキー: ${k}`);
          attrs = setAttr(attrs, attr, dict[k]);
        }
      }
      if (key) {
        if (dict[key] == null) throw new Error(`辞書に無いキー: ${key}`);
        content = escText(dict[key].replace(/\{(\w+)\}/g, (all, n) => LOGOS[n] ?? all));
      }
      if (json) {
        if (dict[json] == null) throw new Error(`辞書に無いキー: ${json}`);
        // </script> を閉じさせない
        content = "\n" + JSON.stringify(dict[json], null, 2).replace(/</g, "\\u003c") + "\n";
      }
    }
    return { attrs, content };
  });
}

// ---- 配布物 ----
// PC の版は、pre-release・draft でない最新の vX.Y.Z の Release。Android は pre-release で出しているので、最新の android-v… の Release の APK。
// 配布物の名前に版が入るので、決まった URL（releases/latest/download/<名前>）は使えない。Release を出した後にサイトを組み直すと新しい版になる。
// API が使えないとき（回数の上限・ネットワーク）は、リンクを Releases のページに落とし、版の行を出さない。
const REPO_SLUG = "OzEngineJP/pleiad";
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
const RELEASES_URL = `${REPO_URL}/releases`;
const API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=50`;
const PC_ASSETS = {
  "win-x64": /-win-x64\.exe$/,
  "win-arm64": /-win-arm64\.exe$/,
  "mac-arm64": /-mac-arm64\.dmg$/,
  "mac-x64": /-mac-x64\.dmg$/,
};

/** Releases の一覧（API の返り値）から、ページに焼くリンクと版を選ぶ。選べないものは Releases のページに落とす */
export function pickReleases(list) {
  const links = { notes: RELEASES_URL, all: RELEASES_URL, android: RELEASES_URL };
  for (const key of Object.keys(PC_ASSETS)) links[key] = RELEASES_URL;
  const release = { version: null, date: null, links };
  const pc = (list ?? []).find((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name));
  if (pc) {
    release.version = pc.tag_name;
    release.date = pc.published_at;
    links.all = pc.html_url;
    for (const [key, re] of Object.entries(PC_ASSETS)) {
      links[key] = pc.assets.find((a) => re.test(a.name))?.browser_download_url ?? pc.html_url;
    }
  }
  const android = (list ?? []).find((r) => !r.draft && /^android-v/.test(r.tag_name) && r.assets.some((a) => /\.apk$/.test(a.name)));
  if (android) links.android = android.assets.find((a) => /\.apk$/.test(a.name)).browser_download_url;
  return release;
}

export async function fetchReleases() {
  const headers = { accept: "application/vnd.github+json", "user-agent": "pleiad-site-build" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(API_URL, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = pickReleases(await res.json());
    if (!release.version) throw new Error("安定版の Release が見つからない");
    return release;
  } catch (err) {
    console.warn(`! Releases を取れなかったので、ダウンロードのリンクを ${RELEASES_URL} にする（${err.message}）`);
    return pickReleases([]);
  }
}

function formatDate(iso, lang) {
  const d = new Date(iso);
  if (lang === "ja") return d.toISOString().slice(0, 10);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** data-release="キー" の付いた要素に、リンク（href）か版の行（version: 中身）を焼く */
export function applyRelease(html, release, lang) {
  return rewriteTags(html, /\sdata-release=/, (name, attrs) => {
    const key = attrs.match(/\sdata-release="([^"]+)"/)[1];
    attrs = attrs.replace(/\sdata-release="[^"]*"/, "");
    if (key === "version") {
      return { attrs, content: release.version ? `${release.version} · ${formatDate(release.date, lang)}` : "" };
    }
    if (!(key in release.links)) throw new Error(`知らない data-release: ${key}`);
    return { attrs: setAttr(attrs, "href", release.links[key]), content: null };
  });
}

function headTags(lang, page) {
  const L = LANGS[lang];
  const other = lang === "ja" ? "en" : "ja";
  return [
    `<link rel="canonical" href="${SITE_URL}${L.dir}${page}">`,
    `<link rel="alternate" hreflang="ja" href="${SITE_URL}${page}">`,
    `<link rel="alternate" hreflang="en" href="${SITE_URL}${LANGS.en.dir}${page}">`,
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}${page}">`,
    `<meta property="og:url" content="${SITE_URL}${L.dir}${page}">`,
    `<meta property="og:locale" content="${L.locale}">`,
    `<meta property="og:locale:alternate" content="${LANGS[other].locale}">`,
    `<meta property="og:image" content="${SITE_URL}${L.ogImage}">`,
  ].join("\n");
}

const depthOf = (page) => page.split("/").filter(Boolean).length;

// 言語の切り替え: 地球のアイコンと今の言語の名前。開くと各言語をその言語の名前で並べる（同じページの別の言語へ）
function langSwitch(lang, page) {
  const ja = lang === "ja";
  const up = "../".repeat(depthOf(page));
  const item = (code, href, name) =>
    `<a href="${href}" hreflang="${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ""}>${name}</a>`;
  return [
    '<details class="lang">',
    `  <summary class="lang-btn" aria-label="${ja ? "言語" : "Language"}"><svg aria-hidden="true"><use href="#i-globe"/></svg><span class="lang-cur">${ja ? "日本語" : "English"}</span><svg class="lang-chev" aria-hidden="true"><use href="#i-chev"/></svg></summary>`,
    '  <div class="lang-menu">',
    `    ${item("ja", ja ? "./" : `../${up}${page}`, "日本語")}`,
    `    ${item("en", ja ? `${up}en/${page}` : "./", "English")}`,
    "  </div>",
    "</details>",
  ].join("\n");
}

/** page は公開先のパス（"" か "download/"）。release を省くと、ダウンロードのリンクは Releases のページになる */
export function renderPage(source, lang, dict, { page = "", release = pickReleases([]) } = {}) {
  let html = source.replace(/\r\n/g, "\n");
  html = html.replace("<!-- i18n:head -->", () => headTags(lang, page));
  html = html.replace("<!-- i18n:lang-switch -->", () => langSwitch(lang, page));
  // 言語を限った要素（日本語だけの書体の先読みなど）
  html = html.replace(/<link data-only="(\w+)"([^>]*)>\n?/g, (all, only, rest) => (only === lang ? `<link${rest}>\n` : ""));
  html = localize(html, lang === "ja" ? null : dict);
  html = applyRelease(html, release, lang);
  html = html.replace(/<html lang="ja">/, `<html lang="${lang}">`);
  if (lang !== "ja") {
    // en/ から見た共有の資源（正本のページからの相対に ../ を 1 つ足す）
    html = html.replace(/\b(src|href)="((?:\.\.\/)*)(assets\/|styles\.css|main\.js|hero\.js|branch\.js|os\.js|plus\.js)/g, '$1="../$2$3');
  }
  return html;
}

function copyShared(out) {
  for (const name of fs.readdirSync(SITE)) {
    if (SKIP.has(name)) continue;
    fs.cpSync(path.join(SITE, name), path.join(out, name), { recursive: true });
  }
}

// ---- 文書 ----
// site/docs は Astro Starlight のプロジェクトで、自分の package.json と lockfile を持つ（アプリの依存と混ぜない）。
// Cloudflare のビルド環境は clone が浅くタグが無いので、コードから作る部分は Releases の最新の安定版のタグから
// raw.githubusercontent.com で必要なファイルだけを取る（一覧は tools/docs-sources.mjs の DOCS_SOURCE_FILES。
// ファイルを足したら一覧にも足す。tests/unit/docs-source.mjs が閉包と突き合わせる）。
// 古いタグ（新しいモジュールが無い v0.40.0 など）は、一覧だけを作る形に落とす（ビルドを落とさない）。
// 取れないとき（--offline・API の失敗）は作業ツリーの core/ から作り、その旨をページに出す。
const DOCS = path.join(SITE, "docs");
const RAW_URL = `https://raw.githubusercontent.com/${REPO_SLUG}`;
const WORKTREE_SOURCE = { core: path.join(SITE, "..", "core", "backends"), label: "worktree" };

async function fetchSource(rel, file, version) {
  const res = await fetch(`${RAW_URL}/${version}/${rel}`, {
    headers: { "user-agent": "pleiad-site-build" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`${rel}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await res.text());
}

/**
 * 文書の生成に使う core/backends の写し。タグから取れたらその写し、取れなければ作業ツリー。
 * 古いタグで新しいモジュールが無いときは、一覧だけの元（agents.mjs）を取って .index-only を残す。
 */
async function docsSource(release, offline) {
  if (offline || !release.version) {
    console.warn(`! ${offline ? "--offline" : "安定版の Release を取れなかった"}ので、文書の生成に使う core/ を作業ツリーから読む`);
    return WORKTREE_SOURCE;
  }
  const dir = path.join(DOCS, ".cache", release.version);
  const core = path.join(dir, "core", "backends");
  const marker = path.join(dir, ".index-only");
  const indexPath = path.join(dir, ...DOCS_INDEX_FILE.split("/"));
  if (fs.existsSync(marker)) {
    if (!fs.existsSync(indexPath)) {
      try {
        await fetchSource(DOCS_INDEX_FILE, indexPath, release.version);
      } catch (err) {
        console.warn(`! ${release.version} の ${DOCS_INDEX_FILE} を取れなかったので、作業ツリーから読む（${err.message}）`);
        return WORKTREE_SOURCE;
      }
    }
    return { core, label: release.version };
  }
  const files = DOCS_SOURCE_FILES.map((rel) => ({ rel, file: path.join(dir, ...rel.split("/")) }));
  if (!files.every(({ file }) => fs.existsSync(file))) {
    try {
      for (const { rel, file } of files) if (!fs.existsSync(file)) await fetchSource(rel, file, release.version);
    } catch (err) {
      // 404 は古いタグ（新しいモジュールが無い）。一覧だけを作り、次のビルドで取り直さないよう印を残す。
      // 通信の失敗・上限は一時的なものなので印を残さず、作業ツリーから作る（次のビルドで取り直す）
      if (err.status !== 404) {
        console.warn(`! ${release.version} の core/ を取れなかったので、作業ツリーから読む（${err.message}）`);
        return WORKTREE_SOURCE;
      }
      console.warn(`! ${release.version} のエージェントのページの元を取れなかったので、一覧だけを作る（${err.message}）`);
      try {
        if (!fs.existsSync(indexPath)) await fetchSource(DOCS_INDEX_FILE, indexPath, release.version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(marker, "");
        return { core, label: release.version };
      } catch (indexErr) {
        console.warn(`! ${release.version} の ${DOCS_INDEX_FILE} も取れなかったので、作業ツリーから読む（${indexErr.message}）`);
        return WORKTREE_SOURCE;
      }
    }
  }
  return { core, label: release.version };
}

/**
 * 操作・設定の一覧の元（tests/ops-surface.snap.json）。作業ツリーから組むならそのファイル、タグから組むならタグの写し。
 * タグから取れなければ "none"（リファレンスの章を作らない。開発中の一覧を安定版の文書に混ぜない）
 */
async function docsSnapshot(source) {
  if (source.label === "worktree") return path.join(SITE, "..", ...DOCS_SNAPSHOT_FILE.split("/"));
  const file = path.join(DOCS, ".cache", source.label, ...DOCS_SNAPSHOT_FILE.split("/"));
  if (fs.existsSync(file)) return file;
  try {
    await fetchSource(DOCS_SNAPSHOT_FILE, file, source.label);
    return file;
  } catch (err) {
    console.warn(`! ${source.label} の ${DOCS_SNAPSHOT_FILE} を取れなかったので、リファレンスの章を作らない（${err.message}）`);
    return "none";
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} が失敗した（exit ${result.status}）`);
}

/** site/docs の依存を入れる。Windows の npm は .cmd なので cmd.exe から起こす（shell: true は Node が警告を出す） */
function installDocs() {
  console.log("docs: site/docs の依存を入れる（npm ci）");
  const args = ["ci", "--no-audit", "--no-fund"];
  if (process.platform === "win32") run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], DOCS);
  else run("npm", args, DOCS);
}

/** site/docs を組み、_site/docs/ に写す。install が false なら node_modules が無いときだけ止まる */
export async function buildDocs(out, { offline = false, release = pickReleases([]), install = true } = {}) {
  const astro = path.join(DOCS, "node_modules", "astro", "bin", "astro.mjs");
  if (!fs.existsSync(astro)) {
    if (!install) throw new Error("site/docs の依存が無い（npm ci --prefix site/docs。--no-install を外すと組むときに自動で入れる）");
    installDocs();
  }
  const source = await docsSource(release, offline);
  const snap = await docsSnapshot(source);
  run(process.execPath, [path.join(DOCS, "scripts", "generate.mjs"), "--core", source.core, "--snap", snap, "--source", source.label], DOCS);
  run(process.execPath, [astro, "build"], DOCS);
  fs.cpSync(path.join(DOCS, "dist"), path.join(out, "docs"), { recursive: true });
  console.log(`built docs: /docs/ ・/docs/en/（${source.label === "worktree" ? "作業ツリー" : source.label}）`);
}

export async function build(out, { offline = false, install = true } = {}) {
  const en = JSON.parse(fs.readFileSync(path.join(SITE, "locales", "en.json"), "utf8"));
  const release = offline ? pickReleases([]) : await fetchReleases();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "en"), { recursive: true });
  copyShared(out);
  for (const { src, path: page } of PAGES) {
    const source = fs.readFileSync(path.join(SITE, src), "utf8");
    for (const [lang, dict] of [["ja", null], ["en", en]]) {
      const file = path.join(out, LANGS[lang].dir, page, "index.html");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderPage(source, lang, dict, { page, release }));
    }
  }
  await buildDocs(out, { offline, release, install });
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(SITE, "..", "_site"));
  const release = await build(out, {
    offline: process.argv.includes("--offline"),
    install: !process.argv.includes("--no-install"),
  });
  console.log(`built ${out} (ja: /, /download/, /docs/  en: /en/, /en/download/, /docs/en/)  ${release.version ?? "Releases のページへのリンク"}`);
}
