// Scopes each docs page to its version: sidebar, previous / next links, search index, edit link.
import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';
import { getCollection } from 'astro:content';

import { MASTER_CONTENT, parseId } from './lib/docs-versions';
import { sidebarGroupLabel } from './lib/sidebar';

type SidebarEntry = StarlightRouteData['sidebar'][number];
type Link = Extract<SidebarEntry, { type: 'link' }>;

const editBase = 'https://github.com/SimonVanMello/yaggui/edit/master/website/';

function links(entries: SidebarEntry[]): Link[] {
  return entries.flatMap((e) => (e.type === 'link' ? [e] : links(e.entries)));
}

let masterFiles: Promise<Set<string>> | undefined;

/** Content files of `master`, relative to `website/`: the targets of "Edit page". */
function getMasterFiles(): Promise<Set<string>> {
  masterFiles ??= getCollection('docs').then(
    (entries) =>
      new Set(
        entries
          .map((e) => e.filePath)
          .filter((f): f is string => f?.startsWith(`${MASTER_CONTENT}/`) === true),
      ),
  );
  return masterFiles;
}

export const onRequest = defineRouteMiddleware(async (context) => {
  const route = context.locals.starlightRoute;
  const parsed = parseId(route.id);
  if (!parsed) return;
  const { version } = parsed;

  const group = route.sidebar.find(
    (e) => e.type === 'group' && e.label === sidebarGroupLabel(version),
  );
  const own = group?.type === 'group' ? group.entries : [];
  route.sidebar = own;

  const pages = links(route.sidebar);
  const current = pages.findIndex((l) => l.isCurrent);
  const { prev, next } = route.entry.data;
  const pick = (link: Link | undefined, override: typeof prev) => {
    if (override === false || !link) return undefined;
    if (typeof override === 'string') return { ...link, label: override };
    if (typeof override === 'object') {
      return { ...link, label: override.label ?? link.label, href: override.link ?? link.href };
    }
    return link;
  };
  route.pagination = {
    prev: current > 0 ? pick(pages[current - 1], prev) : undefined,
    next: current >= 0 ? pick(pages[current + 1], next) : undefined,
  };

  // Search covers the default version only: results never send a visitor to another version.
  if (!version.isDefault) route.entry.data.pagefind = false;

  // Old versions cannot be edited: point to the same file on master when it still exists.
  const file = route.entry.filePath?.replace(/^.*?(src\/content\/docs\/)/, '$1');
  route.editUrl =
    file !== undefined && (await getMasterFiles()).has(file) ? new URL(file, editBase) : undefined;
});
