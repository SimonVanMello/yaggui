import type {
  YagguiError,
  RemoteRemovalPreview,
  RemovedRemote,
  RemoteTag,
  TagPushResult,
} from '../bindings';
import type { MockHistory } from '../mockGraph';
import { isValidRefName } from './refs';

/** Remote management of the mock (M4-7c), with the messages of `git/errors.rs`. */
function mockError(
  code: YagguiError['code'],
  en: string,
  fr: string,
  action: YagguiError['action'] = null,
): YagguiError {
  return { code, message: { en, fr }, action, detail: null, payload: null };
}

type Outcome<T> = { ok: T } | { error: YagguiError };

export function remoteExists(name: string): YagguiError {
  return mockError(
    'remoteExists',
    `A remote named "${name}" already exists.`,
    `Un remote nommé « ${name} » existe déjà.`,
  );
}

export function invalidRemoteName(name: string): YagguiError {
  return mockError(
    'invalidRemoteName',
    `"${name}" is not a valid remote name: no spaces, no leading dash, none of ~ ^ : ? * [ \\.`,
    `« ${name} » n'est pas un nom de remote valide : pas d'espace, pas de tiret au début, aucun de ~ ^ : ? * [ \\.`,
  );
}

export function tagRejected(names: string[]): YagguiError {
  const list = names.join(', ');
  return names.length === 1
    ? mockError(
        'tagRejected',
        `The remote refused the tag ${list}: a tag of that name already exists there and points to another commit. Delete the remote tag first, or rename yours.`,
        `Le remote a refusé le tag ${list} : un tag de ce nom y existe déjà et pointe vers un autre commit. Supprime d'abord le tag distant, ou renomme le tien.`,
        { kind: 'openCommandLog' },
      )
    : mockError(
        'tagRejected',
        `The remote refused the tags ${list}: tags of those names already exist there and point to other commits. The other tags were pushed.`,
        `Le remote a refusé les tags ${list} : des tags de ces noms y existent déjà et pointent vers d'autres commits. Les autres tags ont été poussés.`,
        { kind: 'openCommandLog' },
      );
}

/** Same rules as `check_remote_name`: `refs/remotes/<name>/test` must be a valid ref. */
export function checkRemoteName(name: string): YagguiError | null {
  const refused =
    name === '' || name.startsWith('-') || /\s/.test(name) || !isValidRefName(`${name}/test`);
  return refused ? invalidRemoteName(name) : null;
}

/** Same rules as `check_remote_url`: trimmed, not empty, no leading `-`, no control character. */
export function checkRemoteUrl(url: string): Outcome<string> {
  const trimmed = url.trim();
  if (trimmed === '') {
    return {
      error: mockError('invalidArgument', 'The remote URL is empty.', "L'URL du remote est vide."),
    };
  }
  // eslint-disable-next-line no-control-regex
  if (trimmed.startsWith('-') || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return {
      error: mockError(
        'invalidArgument',
        `"${trimmed}" is not a valid remote URL.`,
        `« ${trimmed} » n'est pas une URL de remote valide.`,
      ),
    };
  }
  return { ok: trimmed };
}

/** The remote's entry, created for a remote only known by its branches. */
function entryOf(history: MockHistory, name: string): MockHistory['remotes'][number] {
  let entry = history.remotes.find((r) => r.name === name);
  if (!entry) {
    entry = { name, url: '' };
    history.remotes.push(entry);
  }
  return entry;
}

function trackingOf(history: MockHistory, name: string) {
  return history.remote.filter((b) => b.name.startsWith(`${name}/`));
}

function checkNew(names: readonly string[], name: string): YagguiError | null {
  return checkRemoteName(name) ?? (names.includes(name) ? remoteExists(name) : null);
}

export function addRemote(
  history: MockHistory,
  names: readonly string[],
  name: string,
  url: string,
  pushUrl: string | null,
): Outcome<null> {
  const fetch = checkRemoteUrl(url);
  if ('error' in fetch) return fetch;
  const push = pushUrl === null ? null : checkRemoteUrl(pushUrl);
  if (push && 'error' in push) return push;
  const refused = checkNew(names, name);
  if (refused) return { error: refused };
  history.remotes.push({ name, url: fetch.ok, ...(push ? { pushUrl: push.ok } : {}) });
  return { ok: null };
}

export function renameRemote(
  history: MockHistory,
  names: readonly string[],
  name: string,
  newName: string,
): Outcome<null> {
  const refused = checkNew(names, newName);
  if (refused) return { error: refused };
  entryOf(history, name).name = newName;
  const prefix = `${name}/`;
  const rename = (branch: string) => `${newName}/${branch.slice(prefix.length)}`;
  // Like `branch.<b>.remote`: upstreams follow even when their tracking branch is gone.
  for (const local of history.local) {
    if (local.upstream?.startsWith(prefix)) local.upstream = rename(local.upstream);
  }
  for (const branch of trackingOf(history, name)) branch.name = rename(branch.name);
  return { ok: null };
}

export function setRemoteUrls(
  history: MockHistory,
  name: string,
  url: string,
  pushUrl: string | null,
): Outcome<null> {
  const fetch = checkRemoteUrl(url);
  if ('error' in fetch) return fetch;
  const push = pushUrl === null ? null : checkRemoteUrl(pushUrl);
  if (push && 'error' in push) return push;
  const entry = entryOf(history, name);
  entry.url = fetch.ok;
  if (push) entry.pushUrl = push.ok;
  else delete entry.pushUrl;
  return { ok: null };
}

export function removalPreview(history: MockHistory, name: string): RemoteRemovalPreview {
  const tracking = trackingOf(history, name).map((b) => b.name);
  return {
    tracking: [...tracking].sort(),
    upstreamOf: history.local
      .filter((b) => b.upstream?.startsWith(`${name}/`))
      .map((b) => b.name)
      .sort(),
  };
}

export function removeRemote(history: MockHistory, name: string): RemovedRemote {
  const entry = entryOf(history, name);
  const tracking = trackingOf(history, name);
  const names = new Set(tracking.map((b) => b.name));
  history.remotes = history.remotes.filter((r) => r !== entry);
  history.remote = history.remote.filter((b) => !names.has(b.name));
  for (const local of history.local) {
    if (local.upstream?.startsWith(`${name}/`)) delete local.upstream;
  }
  return {
    name,
    url: entry.url === '' ? null : entry.url,
    pushUrl: entry.pushUrl ?? null,
    tracking: tracking
      .map((b) => ({
        fullName: `refs/remotes/${b.name}`,
        sha: history.commits[b.commit]?.sha ?? '',
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}

/**
 * Tags the mock remote `remote` holds, by name → commit. A tag pushed again at another
 * commit is refused, like Git without `--force`.
 */
export type MockRemoteTags = Map<string, Map<string, number>>;

export function pushTags(
  remotes: MockRemoteTags,
  remote: string,
  tags: readonly { name: string; commit: number }[],
): Outcome<TagPushResult> {
  let held = remotes.get(remote);
  if (!held) {
    held = new Map();
    remotes.set(remote, held);
  }
  const pushed: string[] = [];
  const rejected: string[] = [];
  let upToDate = 0;
  for (const tag of tags) {
    const there = held.get(tag.name);
    if (there === undefined) {
      held.set(tag.name, tag.commit);
      pushed.push(tag.name);
    } else if (there === tag.commit) upToDate += 1;
    else rejected.push(tag.name);
  }
  if (rejected.length > 0) return { error: tagRejected(rejected.sort()) };
  return { ok: { pushed: pushed.sort(), upToDate } };
}

/** Local tags a mock remote holds at the same commit, like `remote_tags` (sorted by name). */
export function matchRemoteTags(
  tags: readonly { name: string; commit: number }[],
  remotes: MockRemoteTags,
): RemoteTag[] {
  return tags
    .map((tag) => ({
      name: tag.name,
      remotes: [...remotes]
        .filter(([, held]) => held.get(tag.name) === tag.commit)
        .map(([remote]) => remote)
        .sort(),
    }))
    .filter((tag) => tag.remotes.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
