import { create } from 'zustand';

import { currentPreferences, savePreferences } from '../../app/preferences';
import { useTabsStore } from '../../app/tabs/tabsStore';
import type { DiffPreferences, DiffTarget, DiffViewMode } from '../../ipc';
import { closeConflictView } from '../conflicts/conflictViewStore';
import { preloadCodeDiff } from './codeDiffModule';

/** The file whose diff replaces the graph in a tab. */
export interface DiffSelection {
  repoId: number;
  target: DiffTarget;
  path: string;
  oldPath: string | null;
}

export type DiffViewOptions = DiffPreferences;

export const DEFAULT_DIFF_OPTIONS: DiffViewOptions = {
  wrap: false,
  ignoreWhitespace: false,
  contextLines: 3,
  fullFile: false,
  markdownPreview: false,
};

export const CONTEXT_CHOICES = [0, 3, 10, 25] as const;

interface DiffState {
  /** Open diff per tab id. */
  open: Record<string, DiffSelection | undefined>;
  /** `null` until changed in this session: the stored preference applies. */
  view: DiffViewMode | null;
  /** `null` until changed in this session: the stored preference applies. */
  options: DiffViewOptions | null;
  /** Files shown despite the size guards ("Show anyway"), by `fileKey`. */
  forced: Record<string, true | undefined>;
  /** Changed files shown as a flat list or a folder tree. */
  fileLayout: 'list' | 'tree';
}

export const useDiffStore = create<DiffState>(() => ({
  open: {},
  view: null,
  options: null,
  forced: {},
  fileLayout: 'list',
}));

export function targetKey(target: DiffTarget): string {
  return target.kind === 'commits' ? `commits:${target.from ?? '^'}..${target.to}` : target.kind;
}

export function fileKey(selection: DiffSelection): string {
  return `${String(selection.repoId)}|${targetKey(selection.target)}|${selection.oldPath ?? ''}|${selection.path}`;
}

/** Opens `selection` in place of the graph of `tabId` (M1-2: call it from the commit details). */
export function openDiff(tabId: string, selection: DiffSelection): void {
  performance.mark('yaggui:diff-select');
  void preloadCodeDiff();
  closeConflictView(tabId);
  useDiffStore.setState((state) => ({ open: { ...state.open, [tabId]: selection } }));
}

export function closeDiff(tabId: string): void {
  useDiffStore.setState((state) => ({ open: { ...state.open, [tabId]: undefined } }));
}

export function useDiffSelection(tabId: string): DiffSelection | undefined {
  return useDiffStore((state) => state.open[tabId]);
}

export function useDiffView(): DiffViewMode {
  return useDiffStore((state) => state.view) ?? currentPreferences().diffView;
}

export function setDiffView(view: DiffViewMode): void {
  useDiffStore.setState({ view });
  savePreferences({ diffView: view });
}

export function toggleDiffView(): void {
  const current = useDiffStore.getState().view ?? currentPreferences().diffView;
  setDiffView(current === 'split' ? 'unified' : 'split');
}

/** Stored options, completed with the defaults (the field is absent until first saved). */
function storedOptions(): DiffViewOptions {
  return { ...DEFAULT_DIFF_OPTIONS, ...currentPreferences().diffOptions };
}

export function resolveDiffOptions(options: DiffViewOptions | null): DiffViewOptions {
  return options ?? storedOptions();
}

export function useDiffOptions(): DiffViewOptions {
  return resolveDiffOptions(useDiffStore((state) => state.options));
}

/** Applies and persists a change of the diff options. */
export function setDiffOptions(patch: Partial<DiffViewOptions>): void {
  const options = { ...resolveDiffOptions(useDiffStore.getState().options), ...patch };
  useDiffStore.setState({ options });
  savePreferences({ diffOptions: options });
}

/** The options that decide which hunks the backend computes (not `wrap`, which is display only). */
export function hunkOptions(options: DiffViewOptions) {
  const { ignoreWhitespace, contextLines, fullFile } = options;
  return { ignoreWhitespace, contextLines, fullFile };
}

export function forceRender(selection: DiffSelection): void {
  useDiffStore.setState((state) => ({ forced: { ...state.forced, [fileKey(selection)]: true } }));
}

export function setFileLayout(fileLayout: 'list' | 'tree'): void {
  useDiffStore.setState({ fileLayout });
}

// A closed tab forgets its open diff.
useTabsStore.subscribe((state, previous) => {
  if (state.tabs === previous.tabs) return;
  const { open } = useDiffStore.getState();
  const closed = Object.keys(open).filter(
    (tabId) => open[tabId] !== undefined && !state.tabs.some((tab) => tab.id === tabId),
  );
  if (closed.length === 0) return;
  useDiffStore.setState({
    open: Object.fromEntries(Object.entries(open).filter(([tabId]) => !closed.includes(tabId))),
  });
});
