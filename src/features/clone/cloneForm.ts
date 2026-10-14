import type { CloneRequest, GitignoreTemplate, InitRequest } from '../../ipc';

/** Folder name Git would pick for `url`: `https://h/o/repo.git` → `repo`, `git@h:o/repo` → `repo`. */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/** Joins a folder and a name with the separator the folder already uses. */
export function joinPath(parent: string, name: string): string {
  const folder = parent.trim();
  if (!folder) return name;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith('/') || folder.endsWith('\\')
    ? `${folder}${name}`
    : `${folder}${separator}${name}`;
}

/** Last segment of a path, for toasts and labels. */
export function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  );
}

export interface CloneForm {
  url: string;
  parent: string;
  name: string;
  branch: string;
  shallow: boolean;
  depth: string;
  submodules: boolean;
}

export type CloneFormError = 'url' | 'parent' | 'name' | 'depth';

/** Positive whole number, or `null`. */
export function parseDepth(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= 1_000_000 ? value : null;
}

/** The first thing wrong with the form, or `null`. The backend validates again. */
export function validateClone(form: CloneForm): CloneFormError | null {
  if (!form.url.trim()) return 'url';
  if (!form.parent.trim()) return 'parent';
  const name = form.name.trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return 'name';
  if (form.shallow && parseDepth(form.depth) === null) return 'depth';
  return null;
}

export function buildCloneRequest(form: CloneForm, cloneId: string): CloneRequest {
  return {
    cloneId,
    url: form.url.trim(),
    target: joinPath(form.parent, form.name.trim()),
    branch: form.branch.trim() || null,
    depth: form.shallow ? parseDepth(form.depth) : null,
    recurseSubmodules: form.submodules,
  };
}

export interface InitForm {
  folder: string;
  branch: string;
  gitignore: readonly GitignoreTemplate[];
  readme: boolean;
}

export function validateInit(form: InitForm): 'folder' | 'branch' | null {
  if (!form.folder.trim()) return 'folder';
  if (!form.branch.trim()) return 'branch';
  return null;
}

export function buildInitRequest(form: InitForm): InitRequest {
  return {
    target: form.folder.trim(),
    defaultBranch: form.branch.trim(),
    gitignore: [...form.gitignore],
    readme: form.readme,
  };
}

/** Toggles `template`, keeping the list in the order of `all` (stable `.gitignore` output). */
export function toggleTemplate(
  selected: readonly GitignoreTemplate[],
  template: GitignoreTemplate,
  all: readonly GitignoreTemplate[],
): GitignoreTemplate[] {
  const next = selected.includes(template)
    ? selected.filter((t) => t !== template)
    : [...selected, template];
  return all.filter((t) => next.includes(t));
}

/** The progress phase of Git → i18n key suffix, `null` when unknown (shown as is). */
export function phaseKey(phase: string): string | null {
  const lower = phase.toLowerCase();
  const known: [string, string][] = [
    ['enumerating', 'enumerating'],
    ['counting', 'counting'],
    ['compressing', 'compressing'],
    ['receiving', 'receiving'],
    ['resolving', 'resolving'],
    ['updating', 'updating'],
  ];
  return known.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null;
}
