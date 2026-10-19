import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { i18nLoader } from '@astrojs/starlight/loaders';

import {
  contentDir,
  contentId,
  LOCALES,
  pagePath,
  versions,
  type Locale,
} from './lib/docs-versions';

// Every version (master and the releases extracted by scripts/versions.ts) lands in the one `docs`
// collection, under an id that encodes locale and version: `docs/…` (default version),
// `docs/next/…`, `docs/0.3.0/…`, and the same under `fr/`. Files are `<content dir>/<locale>/<page>`.
const sources = versions.map((v) => ({ v, dir: contentDir(v) }));

const docs = defineCollection({
  loader: glob({
    base: '.',
    pattern: sources.map(({ dir }) => `${dir}/{${LOCALES.join(',')}}/**/[^_]*.{md,mdx}`),
    generateId: ({ entry }) => {
      const source = sources.find(({ dir }) => entry.startsWith(`${dir}/`));
      if (!source) throw new Error(`docs: no version for ${entry}`);
      const [locale = '', ...file] = entry.slice(source.dir.length + 1).split('/');
      return contentId(locale as Locale, source.v, pagePath(file.join('/')));
    },
  }),
  schema: docsSchema({
    extend: z.object({
      /** Globs of the code paths this page documents (repository-relative); drives `docs-impact`. */
      sources: z.array(z.string().min(1)),
      /** Requirements of docs/SPEC.md this page covers. */
      requirements: z.array(z.string().regex(/^F-\d{3}$/, 'expected an F-xxx id')),
    }),
  }),
});

// Overrides of Starlight's UI strings, if any: src/content/i18n/<locale>.json.
const i18n = defineCollection({ loader: i18nLoader(), schema: i18nSchema() });

export const collections = { docs, i18n };
