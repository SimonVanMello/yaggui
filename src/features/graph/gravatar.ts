import { useEffect, useSyncExternalStore } from 'react';

import { usePreferences } from '../../app/usePreferences';
import { ipc, unwrap } from '../../ipc';
/**
 * Gravatar avatars (F-033), opt-in: nothing here runs, and no request leaves the app, unless
 * the `gravatar` preference is on. The e-mail is hashed locally (SHA-256, which Gravatar
 * accepts) and only the hash goes to the backend, which downloads the picture, keeps it in a
 * disk cache and hands it back as a `data:` URL (already allowed by the CSP: no remote
 * origin in `img-src`). Results are also kept in memory for the session.
 */

const MAX_CACHED = 5000;
/** Pictures kept in memory (a data URL is a few KB); the backend disk cache has the rest. */
const MAX_IMAGES = 1000;
/** Calls to the backend at the same time: it bounds its own downloads, this bounds the calls. */
const MAX_REQUESTS = 6;
/** A failed download (offline) is retried after this long, when the avatar is shown again. */
const RETRY_AFTER_MS = 60_000;

const hashes = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
/** Picture of a hash as a data URL, `null` when Gravatar has none (`d=404`). */
const images = new Map<string, string | null>();
const requested = new Set<string>();
const failedAt = new Map<string, number>();
/** Data URLs the webview could not decode. */
const broken = new Set<string>();
const queue: string[] = [];
let running = 0;
let epoch = 0;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** Hex SHA-256 of the normalized e-mail, computed once per address. */
export async function gravatarHash(email: string): Promise<string> {
  const key = normalize(email);
  const known = hashes.get(key);
  if (known !== undefined) return known;
  let running = pending.get(key);
  if (!running) {
    running = crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((buffer) => {
      const hex = Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      if (hashes.size >= MAX_CACHED) hashes.clear();
      hashes.set(key, hex);
      pending.delete(key);
      return hex;
    });
    pending.set(key, running);
  }
  return running;
}

// Rows read the cache through `useSyncExternalStore`: a hash computed or a picture received
// re-renders the avatars of that address only.
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markMissing(url: string): void {
  broken.add(url);
  notify();
}

async function load(hash: string, started: number): Promise<void> {
  try {
    const url = await unwrap(ipc.commands.avatar(hash));
    if (started !== epoch) return;
    if (images.size >= MAX_IMAGES) {
      const oldest = images.keys().next();
      if (!oldest.done) images.delete(oldest.value);
    }
    images.set(hash, url);
  } catch {
    if (started !== epoch) return;
    failedAt.set(hash, Date.now());
    requested.delete(hash);
  }
  notify();
}

function pump(): void {
  while (running < MAX_REQUESTS) {
    // Last in, first out: the rows on screen now come before those scrolled past.
    const hash = queue.pop();
    if (hash === undefined) return;
    running += 1;
    void load(hash, epoch).finally(() => {
      running -= 1;
      pump();
    });
  }
}

function request(hash: string): void {
  if (images.has(hash)) return;
  const failed = failedAt.get(hash);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return;
  if (requested.has(hash)) {
    // Asked again (back on screen): move it to the front of the queue.
    const index = queue.indexOf(hash);
    if (index >= 0) queue.push(...queue.splice(index, 1));
    return;
  }
  requested.add(hash);
  queue.push(hash);
  pump();
}

/** Forgets every picture held in memory (the disk cache was emptied). */
export function resetGravatar(): void {
  epoch += 1;
  images.clear();
  requested.clear();
  failedAt.clear();
  broken.clear();
  queue.length = 0;
  notify();
}

/** Picture of an address, when its hash is computed and the backend already answered. */
function cachedUrl(email: string): string | null {
  const hash = hashes.get(normalize(email));
  if (hash === undefined) return null;
  const url = images.get(hash) ?? null;
  return url === null || broken.has(url) ? null : url;
}

/** Data URL of the author's Gravatar, `null` while loading, when disabled or when there is none. */
export function useGravatar(email: string): string | null {
  const enabled = usePreferences().gravatar === true;
  const usable = enabled && email.includes('@');
  const url = useSyncExternalStore(subscribe, () => (usable ? cachedUrl(email) : null));
  // A reset (cache emptied) leaves the visible avatars without a picture: ask again.
  const generation = useSyncExternalStore(subscribe, () => epoch);
  useEffect(() => {
    if (!usable) return;
    const known = hashes.get(normalize(email));
    if (known !== undefined) {
      request(known);
      return;
    }
    let cancelled = false;
    void gravatarHash(email).then((hash) => {
      if (cancelled) return;
      request(hash);
      notify();
    });
    return () => {
      cancelled = true;
    };
  }, [email, usable, generation]);
  return url;
}

/** Empties the disk cache and the memory of this session; returns the files removed. */
export async function clearGravatarCache(): Promise<number> {
  const removed = await unwrap(ipc.commands.clearAvatarCache());
  resetGravatar();
  return removed;
}
