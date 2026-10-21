// Plus の同期で運ぶもの（docs/plus.md「同期」）。項目の論理名と、この PC の実体の対応。
//
//   settings/<key>              defineSetting の設定のうち sync のもの（値は JSON。既定の値のままのものは項目にしない）
//   skills/claude/<相対パス>      <CLAUDE_CONFIG_DIR か ~/.claude>/skills/ の下
//   skills/agents/<相対パス>      ~/.agents/skills/ の下
//   skills/pleiad/<相対パス>      <data>/skills/ の下
//   instructions/claude|codex|gemini  全体の指示ファイル（core/context-scan.mjs の userInstructionPaths と同じ場所）
//
// 入れないもの: 秘密の置き場の名前（*secret*・api-keys.json など）・.env*・.git/・node_modules/・__pycache__/・ログ・バックアップ・
// 文脈のキャッシュ・1MB を超えるファイル・リンク（symlink・ReparsePoint）とその先。指示ファイル自体がリンクなら運ばない。
// 中身はバイト列のまま運ぶ（改行・文字コード・BOM を変えない）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { userInstructionPaths } from '../../context-scan.mjs';
import { writeAtomic } from '../../atomic-file.mjs';

/** 1 項目の平文の中身の上限（これを超えるファイルは運ばない） */
export const ITEM_LIMIT_BYTES = 1024 * 1024;
// backend-allow: 同期の論理名の置き場の名前（ディスクの置き場の形）で、エージェントの分岐ではない
export const SKILL_SOURCES = ['claude', 'agents', 'pleiad'];
// backend-allow: 同期の論理名の置き場の名前（userInstructionPaths の鍵）で、エージェントの分岐ではない
export const INSTRUCTION_SOURCES = ['claude', 'codex', 'gemini'];

const SETTING_KEY_RX = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'logs', 'backups', 'context-snapshots']);
const NEVER_NAMES = new Set(['api-keys.json', 'claude-accounts.json', 'compat-endpoints.json', 'context-scans.json']);
const WINDOWS_DEVICE_RX = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 名前（パスの 1 段）が運ばないものか。秘密・.env・ログ・バックアップ・文脈のキャッシュ・DB など */
export function skippedName(name) {
  const lower = String(name).toLowerCase();
  return SKIP_DIRS.has(lower) || NEVER_NAMES.has(lower) || lower.startsWith('.env') || lower.includes('secret')
    || lower.startsWith('handoff-') || lower.startsWith('pleiad.db') || lower.endsWith('.log') || lower.endsWith('.bak');
}

/** 1 段の名前として、どの OS でも書ける形か */
const safeSegment = s => s !== '' && s !== '.' && s !== '..' && !/[<>:"|?*\\/\u0000-\u001f]/.test(s) && !/[. ]$/.test(s) && !WINDOWS_DEVICE_RX.test(s);

/**
 * 論理名を読む。形が違う（..・絶対パス・\・表に無い頭・運ばない名前）なら null。
 * @returns {{ kind: 'setting', key: string } | { kind: 'instruction', source: string } | { kind: 'skill', source: string, rel: string[] } | null}
 */
export function parseLogicalPath(p) {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.startsWith('/') || p.includes('\\')) return null;
  const parts = p.split('/');
  if (parts[0] === 'settings') return parts.length === 2 && SETTING_KEY_RX.test(parts[1]) ? { kind: 'setting', key: parts[1] } : null;
  if (!parts.every(safeSegment)) return null;
  if (parts[0] === 'instructions') return parts.length === 2 && INSTRUCTION_SOURCES.includes(parts[1]) ? { kind: 'instruction', source: parts[1] } : null;
  if (parts[0] === 'skills' && parts.length >= 3 && SKILL_SOURCES.includes(parts[1]) && !parts.slice(2).some(skippedName)) {
    return { kind: 'skill', source: parts[1], rel: parts.slice(2) };
  }
  return null;
}

const isLink = st => st?.isSymbolicLink() === true;
const lstat = p => fs.lstat(p).catch(() => null);

/**
 * @param {object} o
 * @param {string} o.dataDir  Pleiad の設定の置き場（<data>）
 * @param {string} [o.home]
 * @param {object} [o.env]    CLAUDE_CONFIG_DIR・CODEX_HOME を読む
 * @param {object|null} [o.settings] 設定の口（server.mjs が作る）:
 *   list(): Promise<[{ key, value }]>（sync の設定のうち既定でないもの）、write(key, value): Promise<boolean>（normalize → write）、
 *   reset(key): Promise<boolean>（既定に戻す）、has(key): boolean（sync の設定か）
 * @param {(line: string) => void} [o.log]
 */
export function createSyncTargets({ dataDir, home = os.homedir(), env = process.env, settings = null, log = () => {} }) {
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
  const instructions = userInstructionPaths({ home, claudeHome, codexHome, geminiHome: path.join(home, '.gemini') });
  const skillRoots = { claude: path.join(claudeHome, 'skills'), agents: path.join(home, '.agents', 'skills'), pleiad: path.join(dataDir, 'skills') };

  /** 論理名 → 手元のファイル（設定・形の違うものは null） */
  function localFile(logical) {
    const p = parseLogicalPath(logical);
    if (p?.kind === 'instruction') return instructions[p.source];
    if (p?.kind === 'skill') return path.join(skillRoots[p.source], ...p.rel);
    return null;
  }

  async function readFile(file) {
    const st = await lstat(file);
    if (!st?.isFile() || isLink(st) || st.size > ITEM_LIMIT_BYTES) return null;
    const content = await fs.readFile(file).catch(() => null);
    return content && content.length <= ITEM_LIMIT_BYTES ? { content, mtimeMs: st.mtimeMs } : null;
  }

  async function walk(root, prefix, out) {
    const st = await lstat(root);
    if (!st?.isDirectory() || isLink(st)) return;   // 置き場自体がリンクなら運ばない（リンクの先へ書かない）
    const stack = [[root, []]];
    while (stack.length) {
      const [dir, rel] = stack.pop();
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (skippedName(e.name) || !safeSegment(e.name)) continue;
        const full = path.join(dir, e.name);
        const est = await lstat(full);
        if (!est || isLink(est)) continue;
        if (est.isDirectory()) stack.push([full, [...rel, e.name]]);
        else if (est.isFile()) {
          const logical = `${prefix}${[...rel, e.name].join('/')}`;
          if (!parseLogicalPath(logical)) continue;
          const got = await readFile(full);
          if (got) out.set(logical, { kind: 'file', ...got });
        }
      }
    }
  }

  /**
   * 手元の今の中身を全部読む。Map<論理名, { kind: 'file'|'setting', content: Buffer, mtimeMs: number|null }>
   */
  async function scan() {
    const out = new Map();
    if (settings) {
      for (const { key, value } of await settings.list()) {
        const logical = `settings/${key}`;
        if (!parseLogicalPath(logical) || value === undefined) continue;
        const content = Buffer.from(JSON.stringify(value), 'utf8');
        if (content.length <= ITEM_LIMIT_BYTES) out.set(logical, { kind: 'setting', content, mtimeMs: null });
      }
    }
    for (const source of SKILL_SOURCES) await walk(skillRoots[source], `skills/${source}/`, out);
    for (const source of INSTRUCTION_SOURCES) {
      const got = await readFile(instructions[source]);
      if (got) out.set(`instructions/${source}`, { kind: 'file', ...got });
    }
    return out;
  }

  /** ファイルの項目 1 つの今の中身（無い・リンク・大きすぎる → null）。設定は扱わない */
  async function readOne(logical) {
    const file = localFile(logical);
    return file ? readFile(file) : null;
  }

  /** 書く先のファイルと、その上の段（置き場の根まで）にリンクが無いか。リンクがあれば書かない */
  async function writable(logical) {
    const p = parseLogicalPath(logical);
    const file = localFile(logical);
    if (!file) return null;
    const st = await lstat(file);
    if (st && (isLink(st) || !st.isFile())) return null;
    if (p.kind === 'skill') {
      let dir = skillRoots[p.source];
      for (const seg of ['', ...p.rel.slice(0, -1)]) {
        dir = seg ? path.join(dir, seg) : dir;
        const dst = await lstat(dir);
        if (dst && (isLink(dst) || !dst.isDirectory())) return null;
      }
    }
    return file;
  }

  /**
   * 受けた中身を手元に書く。書けたら true。設定は normalize → write を通し、落ちたら false（呼び出し側がログに出す）
   * @param {string} logical @param {Buffer} content @param {string|number|Date} mtime
   */
  async function write(logical, content, mtime) {
    const p = parseLogicalPath(logical);
    if (!p || content.length > ITEM_LIMIT_BYTES) return false;
    if (p.kind === 'setting') {
      if (!settings?.has(p.key)) return false;
      let value;
      try { value = JSON.parse(content.toString('utf8')); } catch { return false; }
      return settings.write(p.key, value);
    }
    const file = await writable(logical);
    if (!file) { log(`sync: skipped a link target (${p.kind})`); return false; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, content);
    const when = new Date(mtime);
    if (Number.isFinite(when.getTime())) await fs.utimes(file, when, when).catch(() => {});
    return true;
  }

  /** 手元から消す（設定は既定に戻す）。消せた・もう無いなら true */
  async function remove(logical) {
    const p = parseLogicalPath(logical);
    if (!p) return false;
    if (p.kind === 'setting') return settings?.has(p.key) ? settings.reset(p.key) : false;
    const file = await writable(logical);
    if (!file) return false;
    await fs.rm(file, { force: true });
    if (p.kind === 'skill') {
      // 空になったフォルダーを、置き場の根の手前まで畳む
      const root = skillRoots[p.source];
      for (let dir = path.dirname(file); dir.length > root.length && dir.startsWith(root); dir = path.dirname(dir)) {
        const left = await fs.readdir(dir).catch(() => null);
        if (!left || left.length) break;
        await fs.rmdir(dir).catch(() => {});
      }
    }
    return true;
  }

  /** fs.watch を張る場所。skill の置き場は再帰、指示ファイルはその親（再帰しない）を名前で絞る */
  function watchPlan() {
    return [
      ...SKILL_SOURCES.map(source => ({ dir: skillRoots[source], recursive: true, name: null })),
      ...INSTRUCTION_SOURCES.map(source => ({ dir: path.dirname(instructions[source]), recursive: false, name: path.basename(instructions[source]) })),
    ];
  }

  return { scan, readOne, write, remove, localFile, watchPlan, parse: parseLogicalPath, skillRoots, instructions, hasSetting: key => Boolean(settings?.has(key)) };
}
