// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The French UI says "tu". Backend messages (`message.fr` of typed errors) are shown in the
 * same UI, so they follow the same tone.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** "vous" forms, and imperatives / present in -ez (except words like "chez", "assez"). */
const FORMAL = /\b(vous|votre|vos)\b|\b(?!chez\b|assez\b|nez\b)\p{L}+ez\b/iu;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** French literals of the Rust sources: the string that follows an English one in a call. */
function rustStrings(source: string): string[] {
  return [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
}

describe('French tone', () => {
  it('the French catalog uses "tu"', () => {
    const fr = JSON.parse(readFileSync(join(ROOT, 'src/i18n/fr.json'), 'utf8')) as Record<
      string,
      string
    >;
    const formal = Object.entries(fr).filter(([, text]) => FORMAL.test(text));
    expect(formal).toEqual([]);
  });

  it('backend messages use "tu"', () => {
    const offenders = walk(join(ROOT, 'src-tauri/src'))
      .filter((path) => path.endsWith('.rs'))
      .flatMap((path) =>
        rustStrings(readFileSync(path, 'utf8'))
          .filter((text) => FORMAL.test(text))
          .map((text) => `${relative(ROOT, path)}: ${text}`),
      );
    expect(offenders).toEqual([]);
  });
});
