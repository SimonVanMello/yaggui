import type {
  ConflictKind,
  ConflictLabels,
  ConflictSide,
  YagguiError,
  HistoryResult,
  RepoOperation,
} from '../bindings';
import type { MockGraph } from '../mockGraph';

/** Errors of the history commands (M3-1), with the messages of `git/errors.rs`. */
function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

export type HistoryOpName = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'reset';

const OP_NAMES: Record<HistoryOpName, [string, string]> = {
  merge: ['merge', 'le merge'],
  rebase: ['rebase', 'le rebase'],
  'cherry-pick': ['cherry-pick', 'le cherry-pick'],
  revert: ['revert', 'le revert'],
  reset: ['reset', 'le reset'],
};

export function localChanges(op: HistoryOpName, paths: string[]): YagguiError {
  const [en, fr] = OP_NAMES[op];
  return {
    ...mockError(
      'dirtyWorktree',
      `Your local changes would be overwritten by the ${en}. Commit or stash them first.`,
      `Tes modifications locales seraient écrasées par ${fr}. Commite-les ou mets-les de côté (stash) d'abord.`,
    ),
    payload: { kind: 'dirtyWorktree', paths, canCarry: false },
  };
}

/** `pull`: a merge or rebase started by a pull, worded like `YagguiError::pull_conflicts`. */
export function conflictsError(
  operation: RepoOperation | null,
  paths: string[],
  pull = false,
): YagguiError {
  const [en, fr] = pull
    ? operation?.kind === 'rebase'
      ? [
          'The pull stopped on conflicts: the rebase is in progress. Resolve them, then continue (or skip this commit, or abort the rebase).',
          "Le pull s'est arrêté sur des conflits : le rebase est en cours. Résous-les puis continue (ou passe ce commit, ou annule le rebase).",
        ]
      : [
          'The pull stopped on conflicts: the merge is in progress. Resolve them, then continue to create the merge commit (or abort the merge).',
          "Le pull s'est arrêté sur des conflits : le merge est en cours. Résous-les puis continue pour créer le commit de merge (ou annule le merge).",
        ]
    : operation?.kind === 'rebase'
      ? [
          'The rebase stopped on conflicts. Resolve them, then continue (or skip this commit, or abort the rebase).',
          "Le rebase s'est arrêté sur des conflits. Résous-les puis continue (ou passe ce commit, ou annule le rebase).",
        ]
      : operation?.kind === 'cherryPick'
        ? [
            'The cherry-pick stopped on conflicts. Resolve them, then continue (or skip this commit, or abort).',
            "Le cherry-pick s'est arrêté sur des conflits. Résous-les puis continue (ou passe ce commit, ou annule).",
          ]
        : operation?.kind === 'revert'
          ? [
              'The revert stopped on conflicts. Resolve them, then continue (or abort).',
              "Le revert s'est arrêté sur des conflits. Résous-les puis continue (ou annule).",
            ]
          : [
              'The merge stopped on conflicts. Resolve them, then continue to create the merge commit (or abort the merge).',
              "Le merge s'est arrêté sur des conflits. Résous-les puis continue pour créer le commit de merge (ou annule le merge).",
            ];
  return {
    ...mockError('conflicts', en, fr),
    payload: { kind: 'conflicts', operation, paths },
  };
}

export function mergeNotFastForward(source: string): YagguiError {
  return mockError(
    'notFastForward',
    `The branches have diverged: "${source}" cannot be fast-forwarded. Merge with a merge commit, or rebase.`,
    `Les branches ont divergé : impossible d'avancer rapidement (fast-forward) vers « ${source} ». Fais un merge avec commit de merge, ou un rebase.`,
  );
}

/**
 * `check_mainline` of the backend: a merge needs a parent; `0`, a parent it does not have,
 * or a parent on a plain commit (except `-m 1` for a cherry-pick) are refused.
 */
export function checkMainline(
  sha: string,
  parents: number,
  mainline: number | null,
  allowPlain: boolean,
): YagguiError | null {
  const invalid = (n: number) =>
    mockError(
      'invalidArgument',
      `Parent ${String(n)} does not exist for ${short(sha)}.`,
      `${short(sha)} n'a pas de parent ${String(n)}.`,
    );
  if (mainline === null) return parents > 1 ? mainlineRequired(sha) : null;
  if (mainline === 0) return invalid(0);
  if (parents > 1) return mainline > parents ? invalid(mainline) : null;
  return mainline > 1 || !allowPlain ? invalid(mainline) : null;
}

export function mainlineRequired(sha: string): YagguiError {
  return mockError(
    'mainlineRequired',
    `${short(sha)} is a merge commit: choose which parent's side to keep.`,
    `${short(sha)} est un commit de merge : choisis le parent dont le côté est conservé.`,
  );
}

export function emptyCommit(sha: string | null): YagguiError {
  return sha
    ? mockError(
        'emptyCommit',
        `${short(sha)} brings no change any more (it is probably already applied): skip it.`,
        `${short(sha)} n'apporte plus aucune modification (il est sans doute déjà appliqué) : passe-le.`,
      )
    : mockError(
        'emptyCommit',
        'This commit brings no change any more (it is probably already applied): skip it.',
        "Ce commit n'apporte plus aucune modification (il est sans doute déjà appliqué) : passe-le.",
      );
}

export function noOperation(): YagguiError {
  return {
    ...mockError(
      'noOperation',
      'No merge, rebase, cherry-pick or revert is in progress.',
      "Aucun merge, rebase, cherry-pick ni revert n'est en cours.",
    ),
    action: { kind: 'refresh' },
  };
}

export function notInConflict(path: string): YagguiError {
  return mockError(
    'invalidArgument',
    `"${path}" is not in conflict.`,
    `« ${path} » n'est pas en conflit.`,
  );
}

export function invalidHistoryArgument(en: string, fr: string): YagguiError {
  return mockError('invalidArgument', en, fr);
}

/** One conflicted file of a mock operation: its kind and the three versions. */
export interface MockConflict {
  path: string;
  kind: ConflictKind;
  binary: boolean;
  resolved: boolean;
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

/** Text versions in the 3-way editor; binary files carry only a size. */
export function conflictSide(text: string | null, binary: boolean): ConflictSide | null {
  if (text === null) return null;
  return {
    id: null,
    text: binary ? null : text,
    binary,
    size: text.length,
  };
}

/** Working tree content Git leaves for a conflict, with markers named after the sides. */
export function mergedText(conflict: MockConflict, labels: ConflictLabels): string | null {
  const { kind, ours, theirs, binary } = conflict;
  if (binary) return ours;
  if (kind === 'deletedByUs') return theirs;
  if (kind === 'deletedByThem' || kind === 'addedByUs') return ours;
  if (kind === 'addedByThem') return theirs;
  if (kind === 'bothDeleted') return null;
  const name = (side: ConflictLabels['ours']) =>
    side.branch ?? (side.commit ? `${short(side.commit.sha)} (${side.commit.summary})` : 'HEAD');
  const [o, t] = [ours ?? '', theirs ?? ''];
  const common = o.split('\n').findIndex((line, i) => line !== t.split('\n')[i]);
  const lines = o.split('\n');
  const head = common > 0 ? `${lines.slice(0, common).join('\n')}\n` : '';
  const strip = (text: string) => (common > 0 ? text.split('\n').slice(common).join('\n') : text);
  return `${head}<<<<<<< ${name(labels.ours)}\n${strip(o)}=======\n${strip(t)}>>>>>>> ${name(labels.theirs)}\n`;
}

/**
 * Conflicts of the mock scenarios: a content conflict, a deletion against a modification,
 * an add/add and a binary file, so every case of the conflict list shows.
 */
export function scenarioConflicts(): MockConflict[] {
  const base = [
    "import { useState } from 'react';",
    '',
    'export function App() {',
    '  const [count, setCount] = useState(0);',
    '  return <button onClick={() => setCount(count + 1)}>{count}</button>;',
    '}',
    '',
  ].join('\n');
  return [
    {
      path: 'src/app/App.tsx',
      kind: 'content',
      binary: false,
      resolved: false,
      base,
      ours: base.replace('useState(0)', 'useState(1)'),
      theirs: base
        .replace('<button', '<button type="button"')
        .replace('useState(0)', 'useState(10)'),
    },
    {
      path: 'docs/legacy.md',
      kind: 'deletedByThem',
      binary: false,
      resolved: false,
      base: '# Legacy\n\nOld notes.\n',
      ours: '# Legacy\n\nOld notes, updated.\n',
      theirs: null,
    },
    {
      path: 'src/theme/colors.ts',
      kind: 'bothAdded',
      binary: false,
      resolved: false,
      base: null,
      ours: "export const accent = '#3b82f6';\n",
      theirs: "export const accent = '#22c55e';\n",
    },
    {
      path: 'assets/logo.png',
      kind: 'content',
      binary: true,
      resolved: false,
      base: '\u0089PNG base',
      ours: '\u0089PNG ours!',
      theirs: '\u0089PNG theirs!!',
    },
  ];
}

/** A history operation stopped in the mock, and what finishing or skipping it does. */
export interface MockOperation {
  operation: RepoOperation;
  labels: ConflictLabels;
  message: string | null;
  conflicts: MockConflict[];
  /** Completes the operation (after `continue`), with the message the caller gave. */
  complete: (graph: MockGraph, message: string | null) => HistoryResult;
  /** Completes it without the commit it stopped on (`skip`); `null`: not skippable. */
  skip: ((graph: MockGraph) => HistoryResult) | null;
  /**
   * Number of times `continue` / `skip` stop again on new conflicts before completing
   * (rebase only), the rebase moving one step forward each time.
   */
  stopsAgain: number;
  /** Stopped on a commit that brings nothing (`emptyCommit`): continue needs staged changes. */
  empty?: boolean;
}

export function operationInProgress(): YagguiError {
  return mockError(
    'operationInProgress',
    'Another operation (merge, rebase, cherry-pick, revert or bisect) is in progress: continue or abort it first.',
    "Une autre opération (merge, rebase, cherry-pick, revert ou bisect) est en cours : continue-la ou annule-la d'abord.",
  );
}

/**
 * Mock merge tool, as `merge.tool` would name it; none in a repo whose path says so
 * (`no-mergetool`). `mergetool-fails` in the path: the tool cannot start
 * (`mergeToolFailed`); `mergetool-unsaved`: it is closed without saving (not resolved).
 */
export function mockMergeTool(repoPath: string): string | null {
  return /no-mergetool/.test(repoPath) ? null : 'meld';
}

export function mergeToolMissing(): YagguiError {
  return mockError(
    'mergeToolMissing',
    'No external merge tool is configured: set merge.tool in your Git configuration.',
    "Aucun outil de merge externe n'est configuré : renseigne merge.tool dans ta configuration Git.",
  );
}

export function mergeToolFailed(tool: string): YagguiError {
  return mockError(
    'mergeToolFailed',
    `The merge tool "${tool}" could not be started. Check that it is installed and configured (mergetool.${tool}.cmd).`,
    `L'outil de merge « ${tool} » n'a pas pu être lancé. Vérifie qu'il est installé et configuré (mergetool.${tool}.cmd).`,
  );
}

/** Stand-in image of one side of a binary conflict: a square of a different color per side. */
export function mockConflictImage(path: string, stage: 'base' | 'ours' | 'theirs'): string | null {
  if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return null;
  const fill = { base: '#9ca3af', ours: '#3b82f6', theirs: '#22c55e' }[stage];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" rx="8" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
