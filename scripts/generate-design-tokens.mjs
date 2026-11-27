import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = 'packages/design-tokens/tokens.css';
const banner = `/* Generated from ${source}. Run node scripts/generate-design-tokens.mjs. */\n`;

function declarations(block) {
  const values = {};
  for (const declaration of block.split(';')) {
    if (!declaration.trim()) continue;
    const [, name, value] = /^\s*(--[\w-]+|color-scheme)\s*:\s*(.+?)\s*$/s.exec(declaration) ?? [];
    if (!name || Object.hasOwn(values, name)) throw new Error(`Unexpected declaration: ${declaration}`);
    values[name] = value;
  }
  delete values['color-scheme'];
  return values;
}

function resolveAliases(values) {
  function resolve(name, seen = new Set()) {
    if (seen.has(name) || !Object.hasOwn(values, name)) throw new Error(`Invalid token reference: ${name}`);
    return values[name].replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref) => resolve(ref, new Set([...seen, name])));
  }
  return Object.fromEntries(Object.keys(values).map(name => [name, resolve(name)]));
}

function readThemes(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  // Export the two themes at the default viewport and motion settings.
  const rules = new RegExp([
    /^:root\s*\{([^{}]+)\}/,
    /@media\s*\(max-width:\s*700px\)\s*\{\s*:root\s*\{[^{}]+\}\s*\}/,
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^{}]+)\}\s*\}/,
    /:root\[data-theme="dark"\]\s*\{([^{}]+)\}/,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*:root\s*\{[^{}]+\}\s*\}$/,
  ].map(rule => rule.source).join('\\s*'));
  const match = rules.exec(clean);
  if (!match) throw new Error(`Unexpected rule structure in ${source}`);
  const [, baseBlock, systemDarkBlock, explicitDarkBlock] = match;
  const base = declarations(baseBlock);
  const systemDark = resolveAliases({ ...base, ...declarations(systemDarkBlock) });
  const dark = resolveAliases({ ...base, ...declarations(explicitDarkBlock) });
  for (const name of new Set([...Object.keys(systemDark), ...Object.keys(dark)])) {
    if (systemDark[name] !== dark[name]) throw new Error(`Dark theme declarations disagree: ${name}`);
  }
  return { default: resolveAliases(base), dark };
}

export function generateDesignTokens({ check = false } = {}) {
  const css = readFileSync(new URL(source, root), 'utf8').replace(/\r\n/g, '\n');
  const themes = readThemes(css);
  // The public site uses the light palette in both OS modes.
  const siteTokens = ['--surface-paper', '--surface-0', '--ink', '--ink-strong', '--ink-weak',
    '--ink-blue', '--line-blue', '--ink-mark', '--line'];
  const siteDeclarations = siteTokens.map(name => {
    if (!Object.hasOwn(themes.default, name)) throw new Error(`Missing site token: ${name}`);
    return `  ${name}: ${themes.default[name]};\n`;
  }).join('');
  const outputs = {
    'packages/design-tokens/tokens.json': JSON.stringify(themes, null, 2) + '\n',
    'web/tokens.css': banner + css,
    'mobile/www/tokens.css': banner + css,
    'site/tokens.css': banner + ':root {\n' + siteDeclarations + '}\n',
  };
  for (const [path, content] of Object.entries(outputs)) {
    const file = new URL(path, root);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (check) {
      if (existing.replace(/\r\n/g, '\n') !== content) {
        throw new Error(`${path} is out of date. Run node scripts/generate-design-tokens.mjs.`);
      }
    } else {
      writeFileSync(file, existing.includes('\r\n') ? content.replace(/\n/g, '\r\n') : content);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateDesignTokens({ check: process.argv.includes('--check') });
}
