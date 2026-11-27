import { readFileSync } from 'node:fs';
import { generateDesignTokens } from '../../scripts/generate-design-tokens.mjs';

export const name = 'design-tokens';
export const title = 'デザイントークンの CSS と配布用のファイルが一致する';

export default function (t) {
  generateDesignTokens({ check: true });
  const tokens = JSON.parse(readFileSync(new URL('../../packages/design-tokens/tokens.json', import.meta.url), 'utf8'));
  t.ok('既定とダークの配色を CSS と同じ形式で持つ',
    tokens.default['--surface-paper'] === '#ffffff' && tokens.dark['--surface-paper'] === '#1b1c23'
    && tokens.dark['--shadow'] === 'rgba(0,0,0,.5)');
  t.ok('別名を解決し、間隔・角丸・時間の単位を保つ',
    tokens.default['--fs-body'] === '14px' && tokens.dark['--sp-4'] === '16px'
    && tokens.default['--r-pill'] === '999px' && tokens.dark['--spring-smooth-response'] === '.45s');
}
