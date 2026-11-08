import type { Locale } from '../bindings';

/** `DOCS_SITE` in `system/docs.rs`. */
const DOCS_SITE = 'https://yaggui.tropico.dev';
const WORD = /^[a-z0-9-]*$/;

/** `docs_url` in `system/docs.rs`: the address of a docs page, `null` for a refused path. */
export function mockDocsUrl(page: string, locale: Locale): string | null {
  const hash = page.indexOf('#');
  const rawPath = hash === -1 ? page : page.slice(0, hash);
  const anchor = hash === -1 ? '' : page.slice(hash + 1);
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  const valid = path === '' || path.split('/').every((part) => part !== '' && WORD.test(part));
  if (!valid || !WORD.test(anchor)) return null;
  let url = `${DOCS_SITE}${locale === 'fr' ? '/fr' : ''}/docs/`;
  if (path) url += `${path}/`;
  if (anchor) url += `#${anchor}`;
  return url;
}
