// Pleiad がコンテキストを担当する OpenCode のターン（ply_context）の、専用の opencode serve の起こし方（docs/multi-backend.md §2.10「Pleiad 担当のコンテキスト」、ADR 0221）。
//
// OpenCode が自分で読むもの（実機の opencode 1.19.3 のソースと、モデルへ送った要求を受けて確かめた）:
//   - 指示: 設定の置き場の AGENTS.md（無ければ ~/.claude/CLAUDE.md）と、作業場所から Git のルートまでの AGENTS.md・CLAUDE.md・CONTEXT.md（最初に見つかった名前の全部）・設定の instructions
//   - Skills: 設定の置き場と作業場所の .opencode の skill(s)、~/.claude・~/.agents と作業場所の .claude・.agents の skills、設定の skills.paths。名前と説明はシステムプロンプトにも並ぶ
//   - MCP: 設定（全体・作業場所）の mcp
// 指示はサーバーのプロセス全体の設定でしか止められず（会話ごとの口が無い）、Skills もシステムプロンプトの一覧は権限の規則では消えない。そこで、Pleiad が担当するターンは
// 共有のサーバーを使わず、そのターンだけ専用のサーバーを起こす（Codex の専用の app-server と同じ考え）。起こし方:
//   - OPENCODE_DISABLE_PROJECT_CONFIG=1（作業場所の opencode.json・.opencode・指示ファイルを読まない）と、設定の置き場を写した置き場（XDG_CONFIG_HOME）
//   - 写した置き場は、全体の設定の置き場のファイルを写し（設定は Pleiad が担当する種類のキーを外す）、フォルダーは junction でつなぐ。指示を担当するなら AGENTS.md を、Skills を担当するなら skill(s) を置かない
//   - 作業場所の設定（opencode.json・.opencode/opencode.json）は、Pleiad が担当する種類のキーを外して OPENCODE_CONFIG_CONTENT で渡し直す。エージェントに任せる指示ファイルと
//     .opencode の Skills は、instructions・skills.paths の絶対パスで渡し直す（作業場所の設定を止めると、OpenCode は相対パスを設定の置き場から探すため）
//   - Skills を担当するなら OPENCODE_DISABLE_EXTERNAL_SKILLS・OPENCODE_DISABLE_CLAUDE_CODE_SKILLS、指示を担当するなら OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
// 作業場所の .opencode の中のエージェント・コマンド・プラグインは、このターンでは読まれない（作業場所の設定を止めるため。docs/backends.md に書く）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const GLOBAL_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'];
const PROJECT_CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];
const SKILL_DIRS = ['skill', 'skills'];
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];
/** 設定の中で、配列を足し合わせるキー（OpenCode の設定の合わせ方と同じ。ほかの配列は後の値が勝つ） */
const CONCAT = new Set(['plugin', 'instructions']);

/** JSONC（コメントと末尾のカンマを許す JSON）を読む。読めなければ投げる */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const s = String(text ?? '').replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      i = i < 0 ? s.length : i + 2;
    } else { out += c; i++; }
  }
  // 末尾のカンマ（文字列の外だけに残っている）
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** 設定を合わせる（後ろが勝つ。オブジェクトは深く、plugin・instructions は足す） */
export function mergeConfig(base, next) {
  const out = { ...base };
  for (const [k, v] of Object.entries(next ?? {})) {
    if (CONCAT.has(k) && Array.isArray(v) && Array.isArray(out[k])) out[k] = [...out[k], ...v];
    else if (isObject(v) && isObject(out[k])) out[k] = mergeConfig(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** Pleiad が担当する種類のキーを外す */
export function stripOwned(config, owners) {
  const out = { ...config };
  if (owners?.instruction === 'ply') delete out.instructions;
  if (owners?.mcp === 'ply') delete out.mcp;
  if (owners?.skill === 'ply') delete out.skills;
  return out;
}

/** OpenCode の全体の設定の置き場（XDG_CONFIG_HOME、無ければ ~/.config の opencode） */
export function opencodeConfigHome(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
}

const exists = (p) => fs.stat(p).then((s) => s, () => null);

/** 作業場所から上へ、Git のルート（無ければファイルシステムのルート）までのフォルダー（近い順） */
export async function upDirs(cwd) {
  const dirs = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (await exists(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

async function readConfig(file) {
  const st = await exists(file);
  if (!st?.isFile()) return null;
  try { const v = parseJsonc(await fs.readFile(file, 'utf8')); return isObject(v) ? v : null; } catch { return null; }
}

/** 作業場所の設定（Git のルートから作業場所へ、opencode.json(c)、次に .opencode の opencode.json(c)。近いものが勝つ） */
export async function projectConfig(cwd) {
  const dirs = (await upDirs(cwd)).reverse();
  let config = {};
  for (const dir of dirs) for (const name of PROJECT_CONFIG_FILES) { const c = await readConfig(path.join(dir, name)); if (c) config = mergeConfig(config, c); }
  for (const dir of dirs) for (const name of PROJECT_CONFIG_FILES) { const c = await readConfig(path.join(dir, '.opencode', name)); if (c) config = mergeConfig(config, c); }
  return config;
}

/** エージェントに任せる作業場所の指示ファイル（OpenCode と同じく、最初に見つかった名前の、作業場所から上の全部） */
async function projectInstructionFiles(cwd) {
  const dirs = await upDirs(cwd);
  for (const name of INSTRUCTION_FILES) {
    const found = [];
    for (const dir of dirs) if ((await exists(path.join(dir, name)))?.isFile()) found.push(path.join(dir, name));
    if (found.length) return found;
  }
  return [];
}

/** 作業場所の .opencode の Skills のフォルダー */
async function projectSkillDirs(cwd) {
  const out = [];
  for (const dir of await upDirs(cwd)) for (const name of SKILL_DIRS) if ((await exists(path.join(dir, '.opencode', name)))?.isDirectory()) out.push(path.join(dir, '.opencode', name));
  return out;
}

/** 設定の instructions の相対パスを、作業場所から上へ探した絶対パスにする（作業場所の設定を止めると、OpenCode は設定の置き場から探す） */
async function absoluteInstructions(list, cwd) {
  const dirs = await upDirs(cwd);
  const out = [];
  for (const entry of list ?? []) {
    if (typeof entry !== 'string') continue;
    if (/^https?:\/\//.test(entry) || path.isAbsolute(entry) || entry.startsWith('~/')) { out.push(entry); continue; }
    const hit = [];
    for (const dir of dirs) if (await exists(path.join(dir, entry))) hit.push(path.join(dir, entry));
    out.push(...(hit.length ? hit : [path.join(cwd, entry)]));
  }
  return out;
}

const sigOf = (owners) => ['instruction', 'skill', 'mcp'].map((k) => (owners?.[k] === 'ply' ? k[0] : '-')).join('');

/**
 * 全体の設定の置き場を写す（担当の組み合わせごとに 1 つ。<データ置き場>/opencode/managed/<組み合わせ>/opencode）。ターンごとに作り直す。
 * 設定ファイルは担当の種類のキーを外して書き、フォルダーは junction でつなぐ（中身は写さない）。戻りは XDG_CONFIG_HOME に渡す置き場
 */
export async function mirrorGlobalConfig({ dataDir, owners, source = opencodeConfigHome() }) {
  const root = path.join(dataDir, 'opencode', 'managed', sigOf(owners));
  const dest = path.join(root, 'opencode');
  await fs.mkdir(dest, { recursive: true });
  const names = await fs.readdir(source).catch(() => []);
  const keep = new Set();
  for (const name of names) {
    if (name === 'AGENTS.md' && owners?.instruction === 'ply') continue;
    if (SKILL_DIRS.includes(name) && owners?.skill === 'ply') continue;
    const from = path.join(source, name);
    const to = path.join(dest, name);
    const st = await fs.stat(from).catch(() => null);
    if (!st) continue;
    keep.add(name);
    if (GLOBAL_CONFIG_FILES.includes(name)) {
      const config = await readConfig(from);
      if (!config) continue;
      await writeReplacing(to, JSON.stringify(stripOwned(config, owners), null, 2));
    } else if (st.isDirectory()) {
      const now = await fs.lstat(to).catch(() => null);
      if (now?.isSymbolicLink() && path.resolve(await fs.readlink(to).catch(() => '')) === path.resolve(from)) continue;
      await unlinkEntry(to);
      await fs.symlink(from, to, 'junction').catch((err) => { if (err.code !== 'EEXIST') throw err; });
    } else {
      await fs.copyFile(from, to).catch(() => {});
    }
  }
  // 元に無くなったもの・この組み合わせで置かないものを片付ける（OpenCode が入れた node_modules など、写したものでない実体は残す）
  for (const name of await fs.readdir(dest).catch(() => [])) {
    if (keep.has(name)) continue;
    const st = await fs.lstat(path.join(dest, name)).catch(() => null);
    if (st?.isSymbolicLink() || GLOBAL_CONFIG_FILES.includes(name) || name === 'AGENTS.md') await unlinkEntry(path.join(dest, name));
  }
  return root;
}

async function writeReplacing(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file).catch(async () => { await fs.rm(tmp, { force: true }); });
}

/** junction はリンクだけを外す（リンク先は消さない）。ファイルは消す */
async function unlinkEntry(p) {
  const st = await fs.lstat(p).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink()) await fs.unlink(p).catch(() => fs.rmdir(p).catch(() => {}));
  else if (st.isFile()) await fs.rm(p, { force: true });
}

/**
 * 専用のサーバーに足す環境変数と、OPENCODE_CONFIG_CONTENT に合わせる設定。owners は Pleiad の担当（instruction・skill・mcp が 'ply' か）
 */
export async function managedLaunch({ owners, cwd, dataDir, source }) {
  const configHome = await mirrorGlobalConfig({ dataDir, owners, source });
  let config = stripOwned(await projectConfig(cwd), owners);
  if (owners?.instruction !== 'ply') {
    const own = await absoluteInstructions(config.instructions, cwd);
    config = { ...config, instructions: [...await projectInstructionFiles(cwd), ...own] };
  }
  if (owners?.skill !== 'ply') {
    const paths = [...(config.skills?.paths ?? []).map((p) => (typeof p === 'string' && !path.isAbsolute(p) && !p.startsWith('~/') ? path.join(cwd, p) : p)), ...await projectSkillDirs(cwd)];
    if (paths.length) config = { ...config, skills: { ...(config.skills ?? {}), paths } };
  }
  const env = {
    XDG_CONFIG_HOME: configHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    ...(owners?.instruction === 'ply' ? { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1' } : {}),
    ...(owners?.skill === 'ply' ? { OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' } : {}),
  };
  return { env, config };
}
