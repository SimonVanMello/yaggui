// Compresses the docs screenshots in place (last step of `pnpm screenshots:docs` at the repo
// root): truecolor PNGs from Playwright become palette PNGs quantized by libimagequant (sharp's
// `palette` mode, the pngquant engine) at high quality, about a third of the size, with no
// visible difference at docs sizes. Files that already hold a palette are skipped, so running it
// again leaves committed images untouched. Lives in website/ to use its `sharp` dependency.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const dir = fileURLToPath(new URL('../src/assets/screens/', import.meta.url));

/** Color type of the IHDR chunk (byte 25 of a PNG): 3 is indexed. */
const INDEXED = 3;

let before = 0;
let after = 0;
let compressed = 0;
for (const name of (await readdir(dir)).filter((f) => f.endsWith('.png')).sort()) {
  const path = join(dir, name);
  const file = await readFile(path);
  if (file[25] === INDEXED) continue;
  const size = file.length;
  const png = await sharp(file)
    .png({ palette: true, quality: 95, dither: 0.5, effort: 10, compressionLevel: 9 })
    .toBuffer();
  if (png.length >= size) continue;
  await writeFile(path, png);
  before += size;
  after += png.length;
  compressed += 1;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
console.log(
  compressed === 0
    ? 'Screenshots: nothing to compress.'
    : `Screenshots: ${String(compressed)} compressed, ${mb(before)} → ${mb(after)}.`,
);
