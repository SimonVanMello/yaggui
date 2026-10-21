import type {
  BranchStart,
  CheckoutMode,
  CheckoutResult,
  CheckoutTarget,
  CherryPickRequest,
  CommandLogEntry,
  CommitRequest,
  ConflictFile,
  ConflictList,
  ConflictResolution,
  ConflictVersions,
  DeleteBranchResult,
  DeleteBranchesResult,
  GraphFilter,
  DeletedRef,
  ForcePushPreview,
  GitIdentity,
  YagguiError,
  HistoryResult,
  InteractiveRebaseResult,
  KeybindingOverride,
  HunkChange,
  JournalEntry,
  LegacyPreferences,
  LostFile,
  MergeRequest,
  OpKind,
  OpNote,
  PathSelection,
  Preferences,
  RebaseRequest,
  RebaseStop,
  RebaseTodoEntry,
  PullResult,
  PullStrategy,
  PushResult,
  RepoInfo,
  RefNameKind,
  RemovedRemote,
  RepoOperation,
  RepoState,
  ResetPreview,
  ResetRequest,
  ResetResult,
  RevertRequest,
  SideLabel,
  StashEntryInfo,
  StashId,
  TabsState,
  UpdateInfo,
  Workspace,
} from './bindings';
import { GITIGNORE_PREVIEW_MAX, JOURNAL_PATHS_MAX } from './bindings';
import type { YagguiClient, YagguiCommands, YagguiEventMap, YagguiEventName } from './client';
import { EventEmitter } from './emitter';
import {
  gitBinaryInvalid,
  isMockGitPathValid,
  MockCreator,
  mockGitBinaryInfo,
  normalizePreferences,
} from './mock/create';
import {
  appendRule,
  fullMessage,
  MockCommitStore,
  mockCommitSettings,
  mockIgnoreRule,
  mockSignatureCheck,
} from './mock/commitTools';
import { mockChangedFiles, mockFileDiff } from './mock/diff';
import {
  branchCleanup,
  compare,
  deleteBranches,
  diffToolFailed,
  diffToolMissing,
  EMPTY_GRAPH_FILTER,
  isFilterEmpty,
  mergeBase,
  mockDiffImage,
  normalizeFilter,
} from './mock/graphTools';
import { MockPtys } from './mock/pty';
import { mockBlame, mockFileHistory, mockReflog } from './mock/inspect';
import {
  MockJournal,
  mockRefs,
  movedRefs,
  nothingToRedo,
  nothingToUndo,
  undoBlocked,
  undoDiverged,
  undoWouldOverwrite,
  type MockJournalSpec,
  type MockSnapshot,
} from './mock/journal';
import {
  mockAutosquashBase,
  mockAutosquashPlan,
  mockPlan,
  mockRange,
  mockTodo,
  normalizeMockMessage,
  type MockTodoLine,
} from './mock/interactive';
import {
  conflictSide,
  checkMainline,
  conflictsError,
  emptyCommit,
  invalidHistoryArgument,
  localChanges,
  mergedText,
  mergeNotFastForward,
  noOperation,
  notInConflict,
  operationInProgress,
  mergeToolFailed,
  mergeToolMissing,
  mockConflictImage,
  mockMergeTool,
  scenarioConflicts,
  type MockConflict,
  type MockOperation,
} from './mock/history';
import {
  ancestors,
  branchNotMerged,
  currentBranch,
  dirtyWorktree,
  invalidRefName,
  isValidRefName,
  nothingToStash,
  refExists,
  splitRemoteBranch,
  staleRefs,
  stashConflict,
  stashFileConflict,
} from './mock/refs';
import {
  authFailed,
  hostUnreachable,
  OFFLINE_REMOTE_URL,
  isProtectedBranch,
  MOCK_NETWORK_PHASES,
  noUpstream,
  notFastForward,
  protectedBranch,
  pushRejected,
  remoteNotFound,
} from './mock/network';
import { branchInOtherWorktree, MockModules } from './mock/modules';
import {
  addRemote,
  checkRemoteName,
  pushTags,
  removalPreview,
  remoteExists,
  removeRemote,
  renameRemote,
  setRemoteUrls,
  type MockRemoteTags,
} from './mock/remotes';
import {
  blobId,
  fileChanged,
  lineEndingOf,
  MockWip,
  unresolvedConflicts,
  type MockStashState,
} from './mock/wip';
import {
  checkWorkspaceName,
  createMockWorkspaces,
  MOCK_LAST_FETCH_AGO,
  MockScanner,
  sortWorkspaces,
  unknownWorkspace,
} from './mock/workspaces';
import { createMockLog, createMockRepos, mockAppInfo, MOCK_NOW, type MockRepo } from './mockData';
import {
  countExclusive,
  createMockHistory,
  mockSha,
  MockGraph,
  type MockHistory,
} from './mockGraph';
import { mockChangelog } from './mock/changelog';
import {
  exportPreferencesText,
  parsePreferencesFile,
  previewOf,
  sampleImportFile,
} from './mock/prefsSync';
import { MockSettings } from './mock/settings';
import type { IpcResult } from './result';

export { mockAppInfo } from './mockData';

/** The package manager command `update_in_terminal` would run, and what it prints. */
function mockUpgrade(
  update: UpdateInfo,
): { program: string; args: string[]; lines: string[] } | null {
  const { version, currentVersion } = update;
  const cache = '/home/me/.cache/dev.yaggui.app/update';
  const installed = [
    `Unpacking yaggui (${version}) over (${currentVersion}) ...`,
    `Setting up yaggui (${version}) ...`,
  ];
  switch (update.channel) {
    case 'aur':
      return {
        program: '/usr/bin/yay',
        args: ['-S', 'yaggui-bin'],
        lines: [
          ':: Checking for conflicts...',
          `(1/1) upgrading yaggui-bin                [######################] 100%`,
        ],
      };
    case 'deb':
      return {
        program: '/usr/bin/sudo',
        args: ['/usr/bin/apt', 'install', `${cache}/yaggui_${version}_amd64.deb`],
        lines: ['Reading package lists... Done', ...installed],
      };
    case 'rpm':
      return {
        program: '/usr/bin/sudo',
        args: ['/usr/bin/dnf', 'install', `${cache}/yaggui-${version}-1.x86_64.rpm`],
        lines: ['Upgrading:', `  yaggui  x86_64  ${version}-1`, 'Complete!'],
      };
    case 'selfUpdate':
    case 'manual':
      return null;
  }
}

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YagguiError): Promise<IpcResult<T>> {
  return Promise.resolve({ status: 'error', error });
}

function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

function pathArgs(paths: PathSelection): string[] {
  return paths.kind === 'all' ? ['.'] : paths.paths;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Where the mock "file dialogs" save to and read from. */
const MOCK_EXPORT_PATH = '~/Documents/yaggui-preferences.json';
const MOCK_IMPORT_PATH = '~/Downloads/yaggui-preferences.json';

/** Key under which the mock keeps what the real backend stores in SQLite, so reloads keep it. */
export const MOCK_STORE_KEY = 'yaggui.mock.store';

interface PersistedMockStore {
  preferences: Preferences;
  tabs: TabsState;
  legacyMigrated: boolean;
  keybindings?: KeybindingOverride[];
  /** Known repos, like the `repos` table (opened folders survive a reload). */
  repos?: MockRepo[];
  workspaces?: Workspace[];
  /** Graph filters by repo id, like the `graph_filters` table (F-028). */
  graphFilters?: [number, GraphFilter][];
  /** Layout of each repository's view, like the `repo_ui_state` table. */
  repoUiStates?: [number, string][];
}

/** Same bound as `MAX_REPO_UI_STATE` (bytes of UTF-8). */
const MAX_REPO_UI_STATE = 64 * 1024;

const DEFAULT_MOCK_PREFERENCES: Preferences = {
  theme: 'system',
  style: 'standard',
  locale: null,
  terminal: null,
  terminalMode: 'integrated',
  editor: null,
  diffTool: null,
  mergeTool: null,
  diffView: 'split',
  diffOptions: {
    wrap: false,
    ignoreWhitespace: false,
    contextLines: 3,
    fullFile: false,
    markdownPreview: false,
  },
  highContrast: false,
  density: 'comfortable',
  uiFont: null,
  codeFont: null,
  fontSize: 13,
  gitPath: null,
  autoFetch: true,
  autoFetchMinutes: 10,
  prune: true,
  pullStrategy: null,
  protectedBranches: ['main', 'master', 'develop', 'release/*'],
  disabledConfirmations: [],
  gravatar: false,
  // Answered: under the mock, the one-time update question would cover every screen.
  checkUpdates: false,
};

/** Watcher debounce of the real backend: file events reach the UI this long after the change. */
const WATCH_DEBOUNCE_MS = 150;

function invalidPath(path: string): YagguiError {
  return mockError(
    'invalidArgument',
    `Expected an absolute folder path, got "${path}".`,
    `Chemin de dossier absolu attendu, reçu « ${path} ».`,
  );
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
}

/** Same messages as `YagguiError::terminal_not_found`. */
function terminalNotFound(configured: string | null): YagguiError {
  const error = configured
    ? mockError(
        'terminalNotFound',
        `The terminal "${configured}" could not be started. Check its name in the terminal setting.`,
        `Le terminal « ${configured} » n'a pas pu être lancé. Vérifie son nom dans le réglage du terminal.`,
      )
    : mockError(
        'terminalNotFound',
        'No terminal was found on this system. Choose the one to use in the terminal setting.',
        "Aucun terminal n'a été trouvé sur ce système. Choisis celui à utiliser dans le réglage du terminal.",
      );
  return { ...error, action: { kind: 'configureTerminal' } };
}

/** `PTY_SIZE_RANGE` of `system/pty.rs`. */
function isPtySize(cells: number): boolean {
  return Number.isInteger(cells) && cells >= 1 && cells <= 1000;
}

function invalidPtySize(cols: number, rows: number): YagguiError {
  return mockError(
    'invalidArgument',
    `Invalid terminal size ${String(cols)}×${String(rows)}.`,
    `Taille de terminal invalide : ${String(cols)}×${String(rows)}.`,
  );
}

function loadMockStore(): PersistedMockStore | null {
  try {
    const raw = localStorage.getItem(MOCK_STORE_KEY);
    return raw ? (JSON.parse(raw) as PersistedMockStore) : null;
  } catch {
    return null;
  }
}

export interface SimulateOpOptions {
  kind?: OpKind;
  /** Delay between progress steps, in ms. */
  stepMs?: number;
  outcome?: 'success' | 'failed' | 'cancelled';
}

/**
 * Stateful in-browser backend used by `pnpm dev` and `pnpm test:ui` (no Tauri).
 * Besides the contract, it exposes controls to simulate backend activity.
 */
export class MockBackend {
  readonly events = new EventEmitter();
  /** Keybindings file, Git config files and external tools. */
  readonly settings = new MockSettings();
  private repos: MockRepo[] = [];
  /** Open sessions and their reference count (one per tab), like `RepoManager`. */
  private open = new Map<number, number>();
  private tabs: TabsState = { tabs: [], activeTabId: null };
  private preferences: Preferences = { ...DEFAULT_MOCK_PREFERENCES };
  private legacyMigrated = false;
  /** Next answers of the folder picker; when empty, a browser prompt stands in for it. */
  private pickedFolders: (string | null)[] = [];
  /** Texts the next preferences-file pickers open (`null` = the user cancelled). */
  private pickedPreferencesFiles: (string | null)[] = [];
  /** Files "on disk" by path: what was exported, and what a preview read. */
  private preferencesFiles = new Map<string, string>();
  /** `false` simulates a system where no terminal can be found. */
  terminalAvailable = true;
  /** Hashes asked of `avatar`, for tests: nothing is asked while Gravatar is off. */
  readonly avatarRequests: string[] = [];
  /** Hashes in the fake avatar disk cache. */
  private avatarCache = new Set<string>();
  /** Newer version announced by `checkForUpdate`; `null` means up to date. */
  availableUpdate: UpdateInfo | null = null;
  /** Error of the next update check or install, for tests. */
  updateFailure: YagguiError | null = null;
  /** Calls of `checkForUpdate`, for tests: none while the check is off. */
  updateChecks = 0;
  updateInstalls = 0;
  releasePageOpens = 0;
  /** Exit code of the fake package manager of `updateInTerminal`, for tests. */
  upgradeExitCode = 0;
  restarts = 0;
  /** Integrated terminals (F-267): a fake shell. */
  readonly ptys = new MockPtys({
    output: (payload) => {
      this.emit('ptyOutput', payload);
    },
    exited: (payload) => {
      this.emit('ptyExited', payload);
    },
  });
  /** Terminals opened by `openTerminal`, for tests: `{ repoId, program }`. */
  readonly openedTerminals: { repoId: number; path: string; program: string }[] = [];
  private log: CommandLogEntry[] = [];
  private nextOpId = 1;
  private backups = 0;
  private runningOps = new Map<number, () => void>();
  /** Computed graphs, built on first use like the backend cache. */
  private graphs = new Map<number, MockGraph>();
  /** Rows known while a history walk is held (`holdHistoryWalk`). */
  private heldWalk: number | null = null;
  private graphVersions = new Map<number, number>();
  /** Graph filter of each repository (F-028), kept for the session like the SQLite store. */
  private graphFilters = new Map<number, GraphFilter>();
  private repoUiStates = new Map<number, string>();
  /** Files opened by `runDiffTool` and shown by `revealPath`, for tests. */
  readonly externalDiffs: { repoId: number; path: string; tool: string }[] = [];
  readonly revealed: { repoId: number; path: string | null }[] = [];
  /** Live HEAD / index / working tree of the open repositories. */
  private wips = new Map<number, MockWip>();
  /** Changes saved by mock stashes, by stash SHA. */
  private stashStates = new Map<string, MockStashState>();
  /** Identities set with `setGitIdentity` (repo scope, then global). */
  private identities = new Map<number, GitIdentity>();
  private globalIdentity: GitIdentity | null = null;
  /** Identity profiles, commit templates and recent messages (M4-7a). */
  private commitStore = new MockCommitStore();
  /** Merges, rebases, cherry-picks and reverts stopped on conflicts, by repository. */
  private operations = new Map<number, MockOperation>();
  /** Undo journal of each repository, kept when it closes (like `OpJournal` in `yaggui.db`). */
  private journals = new Map<number, MockJournal>();
  /** Repositories whose next interactive rebase stops on conflicts (`simulateRebaseConflict`). */
  private rebaseConflicts = new Set<number>();
  /** Repositories whose next diverged merge / rebase pull stops on conflicts. */
  private pullConflictRepos = new Set<number>();
  /** Tags held by each mock remote, per repository (M4-7c). */
  private remoteTags = new Map<number, MockRemoteTags>();
  private workspaces: Workspace[] = [];
  /** Submodules, worktrees and LFS; `modules.lfsInstalled = false` simulates no `git lfs`. */
  readonly modules = new MockModules();
  /** Last fetch of each repo (`FETCH_HEAD` mtime), seconds since the epoch. */
  private lastFetch = new Map<number, number>();
  /** Folder scans; `scanner.stepMs` sets their pace. */
  readonly scanner = new MockScanner(
    (progress) => {
      this.emit('scanProgress', progress);
    },
    (path) => this.repos.find((repo) => repo.known.path === path)?.known.id ?? null,
  );
  /** Clone and init; `creator.stepMs` sets the pace of a clone. */
  readonly creator = new MockCreator((progress) => {
    this.emit('cloneProgress', progress);
  });

  constructor() {
    this.settings.onChange = () => {
      this.persist();
    };
    const persisted = loadMockStore();
    this.reset();
    if (persisted) {
      this.preferences = { ...DEFAULT_MOCK_PREFERENCES, ...persisted.preferences };
      this.tabs = persisted.tabs;
      if (persisted.repos) this.repos = persisted.repos;
      if (persisted.workspaces) this.workspaces = persisted.workspaces;
      this.graphFilters = new Map(persisted.graphFilters ?? []);
      this.repoUiStates = new Map(persisted.repoUiStates ?? []);
      this.legacyMigrated = persisted.legacyMigrated;
      this.settings.restore(persisted.keybindings ?? []);
      this.persist();
    }
  }

  /** Restores the initial fixtures and forgets persisted data (used between tests). */
  /** Changes the stored preferences at once, e.g. before the app reads them (Playwright). */
  seedPreferences(patch: Partial<Preferences>): void {
    this.preferences = { ...this.preferences, ...patch };
  }

  reset(): void {
    try {
      localStorage.removeItem(MOCK_STORE_KEY);
    } catch {
      // Storage unavailable: nothing persisted.
    }
    this.repos = createMockRepos();
    this.workspaces = createMockWorkspaces();
    this.lastFetch = new Map(
      Object.entries(MOCK_LAST_FETCH_AGO).map(([id, ago]) => [Number(id), MOCK_NOW - (ago ?? 0)]),
    );
    this.scanner.reset();
    this.heldWalk = null;
    this.open = new Map();
    this.tabs = { tabs: [], activeTabId: null };
    this.preferences = { ...DEFAULT_MOCK_PREFERENCES };
    this.legacyMigrated = false;
    this.pickedFolders = [];
    this.pickedPreferencesFiles = [];
    this.preferencesFiles.clear();
    this.creator.reset();
    this.settings.reset();
    this.terminalAvailable = true;
    this.openedTerminals.length = 0;
    this.avatarRequests.length = 0;
    this.avatarCache.clear();
    this.availableUpdate = null;
    this.updateFailure = null;
    this.updateChecks = 0;
    this.updateInstalls = 0;
    this.releasePageOpens = 0;
    this.upgradeExitCode = 0;
    this.restarts = 0;
    this.ptys.reset();
    this.log = createMockLog();
    this.runningOps.forEach((cancel) => {
      cancel();
    });
    this.runningOps.clear();
    this.graphs.clear();
    this.graphVersions.clear();
    this.graphFilters.clear();
    this.repoUiStates.clear();
    this.wips.clear();
    this.identities.clear();
    this.globalIdentity = null;
    this.commitStore.reset(this.repos.find((r) => r.known.name === 'yaggui')?.known.id ?? null);
    this.operations.clear();
    this.journals.clear();
    this.rebaseConflicts.clear();
    this.pullConflictRepos.clear();
    this.modules.reset();
    this.remoteTags.clear();
  }

  private persist(): void {
    const store: PersistedMockStore = {
      preferences: this.preferences,
      tabs: this.tabs,
      legacyMigrated: this.legacyMigrated,
      keybindings: this.settings.overridesSnapshot(),
      repos: this.repos,
      workspaces: this.workspaces,
      graphFilters: [...this.graphFilters],
      repoUiStates: [...this.repoUiStates],
    };
    try {
      localStorage.setItem(MOCK_STORE_KEY, JSON.stringify(store));
    } catch {
      // Storage unavailable: data lives for this page only.
    }
  }

  /** Queues the file the next import preview opens (`null` = the user cancelled). */
  setPickedPreferencesFile(text: string | null): void {
    this.pickedPreferencesFiles.push(text);
  }

  /** The last file `exportPreferences` wrote, for tests. */
  exportedPreferences(): string | null {
    return this.preferencesFiles.get(MOCK_EXPORT_PATH) ?? null;
  }

  /** Queues the answer of the next `pickRepoFolder` call (`null` = the user cancelled). */
  setPickedFolder(path: string | null): void {
    this.pickedFolders.push(path);
  }

  /**
   * Pages report a history walk still running, with `rows` rows known so far, until
   * `releaseHistoryWalk` (the backend without commit-graph, M5-4).
   */
  holdHistoryWalk(rows: number): void {
    this.heldWalk = rows;
  }

  /** Ends the walk held by `holdHistoryWalk`: `graph-progress` with the exact count. */
  releaseHistoryWalk(): void {
    this.heldWalk = null;
    for (const [repoId, graph] of this.graphs) {
      if (!this.open.has(repoId)) continue;
      this.emit('graphProgress', {
        repoId,
        version: graph.version,
        totalRows: graph.order.length,
        exact: true,
        stale: false,
      });
    }
  }

  emit<K extends YagguiEventName>(name: K, payload: YagguiEventMap[K]): void {
    this.events.emit(name, payload);
  }

  /** Replaces part of a repo state and emits `status-changed` (and `refs-changed` if HEAD moved). */
  setRepoState(repoId: number, patch: Partial<RepoState>): void {
    const repo = this.find(repoId);
    if (!repo) return;
    repo.state = { ...repo.state, ...patch };
    // New dirty counts mean another working tree: regenerate it from them.
    if (patch.dirty) this.wips.delete(repoId);
    this.emit('statusChanged', { repoId });
    if (patch.head || patch.upstream !== undefined) {
      // A new HEAD means another history: regenerate it, with a new graph version.
      this.graphs.delete(repoId);
      this.emit('refsChanged', { repoId });
    }
  }

  /** Appends a command log entry and emits `command-logged`. */
  logCommand(entry: Omit<CommandLogEntry, 'id'>): CommandLogEntry {
    const stored = { ...entry, id: (this.log.at(-1)?.id ?? 0) + 1 };
    this.log.push(stored);
    this.emit('commandLogged', { entry: stored });
    return stored;
  }

  /** Simulates a queued fetch-like operation: started → progress… → logged → finished. */
  simulateOp(repoId: number, options: SimulateOpOptions = {}): number {
    const { kind = 'fetch', stepMs = 250, outcome = 'success' } = options;
    const opId = this.nextOpId++;
    const phases: [string, number][] = [
      ['Counting objects', 100],
      ['Compressing objects', 100],
      ['Receiving objects', 35],
      ['Receiving objects', 80],
      ['Receiving objects', 100],
      ['Resolving deltas', 100],
    ];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const repo = this.find(repoId);
    const finish = (result: 'success' | 'failed' | 'cancelled') => {
      timers.forEach(clearTimeout);
      this.runningOps.delete(opId);
      this.logCommand({
        repoId,
        args: [kind, '--progress'],
        cwd: repo?.known.path ?? null,
        startedAt: MOCK_NOW,
        durationMs: phases.length * stepMs,
        exitCode: result === 'success' ? 0 : result === 'failed' ? 128 : null,
        status: result,
        stdout: '',
        stderr:
          result === 'failed' ? 'fatal: unable to access remote: Could not resolve host\n' : '',
        truncated: false,
      });
      this.emit('opFinished', {
        repoId,
        opId,
        kind,
        outcome:
          result === 'failed'
            ? {
                kind: 'failed',
                error: {
                  ...mockError('gitFailed', 'The Git command failed.', 'La commande Git a échoué.'),
                  action: { kind: 'openCommandLog' },
                  detail: 'fatal: unable to access remote: Could not resolve host',
                },
              }
            : result === 'success'
              ? { kind: 'success', note: null }
              : { kind: 'cancelled' },
      });
      // On the real backend the watcher reports the new refs, after its debounce.
      if (result === 'success') {
        setTimeout(() => {
          this.emit('refsChanged', { repoId });
        }, WATCH_DEBOUNCE_MS);
      }
    };

    this.emit('opStarted', { repoId, opId, kind, cancellable: true });
    phases.forEach(([phase, percent], index) => {
      timers.push(
        setTimeout(() => {
          this.emit('opProgress', {
            repoId,
            opId,
            phase,
            percent,
            current: percent * 12,
            total: 1200,
            bytes: percent * 24_000,
            bytesPerSec: 1_800_000,
          });
        }, stepMs * index),
      );
    });
    timers.push(
      setTimeout(() => {
        finish(outcome);
      }, stepMs * phases.length),
    );
    this.runningOps.set(opId, () => {
      finish('cancelled');
    });
    return opId;
  }

  /**
   * Simulates a commit on HEAD made outside yaggui: the graph gets a new version and
   * `refs-changed` is emitted after the watcher debounce. Returns the new SHA.
   */
  simulateCommit(repoId: number, summary = 'feat: commit made from a terminal'): string | null {
    const sha = this.addCommit(repoId, summary, '', false);
    if (sha !== null) this.watcherSaw(repoId, true);
    return sha;
  }

  /**
   * Writes a working tree file as an editor would, then emits `status-changed` like the
   * watcher. After a discard or a hard reset, the undo then refuses with
   * `undoWouldOverwrite`, as the backend does for files changed since.
   */
  simulateEdit(repoId: number, path: string, text: string): boolean {
    const wip = this.wip(repoId);
    const repo = this.find(repoId);
    if (!wip || !repo) return false;
    wip.writeFile(path, text);
    repo.state = { ...repo.state, dirty: wip.dirty() };
    this.watcherSaw(repoId, false);
    return true;
  }

  /**
   * Adds a remote named `offline` whose host can't be reached: fetching it (alone or with
   * `--all`), pulling from or pushing to it fails with `hostUnreachable`, a typed error whose
   * suggested action is `retry`. Lets tests trigger a network failure through the real UI.
   */
  addOfflineRemote(repoId: number): void {
    const graph = this.graph(repoId);
    if (!graph || graph.history.remotes.some((r) => r.name === 'offline')) return;
    graph.history.remotes.push({ name: 'offline', url: OFFLINE_REMOTE_URL });
    this.watcherSaw(repoId, true);
  }

  /**
   * Puts an open repository in the middle of an operation stopped on the scenario conflicts
   * (content, deletion/modification, add/add, binary), as if started from a terminal:
   * `simulateOperation(id, 'rebase', { step: 3, total: 7 })` shows « Rebase 3/7 ». Continue
   * completes it (`stopsAgain` more stops first, rebase only); skip drops the commit; abort
   * restores the files. Emits `status-changed` like the watcher.
   */
  simulateOperation(
    repoId: number,
    kind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect',
    { step = 3, total = 7, stopsAgain = 0 } = {},
  ): boolean {
    const graph = this.graph(repoId);
    if (!graph || !this.wip(repoId)) return false;
    this.endOperation(repoId);
    const head = graph.headCommit();
    const { history } = graph;
    const branch = history.head.kind === 'branch' ? history.head.name : null;
    const other = history.local.find((b) => b.name !== branch && b.commit !== head) ?? null;
    const theirs = other?.commit ?? head;
    const operation: RepoOperation =
      kind === 'rebase'
        ? { kind, interactive: true, step, total, headName: branch }
        : kind === 'merge'
          ? { kind, squash: false }
          : { kind };
    const done = (g: MockGraph) => this.historyResult(g, 'commits', head);
    this.stopOnConflicts(repoId, {
      operation,
      labels:
        kind === 'rebase'
          ? {
              ours: this.sideLabel(graph, other?.name ?? null, theirs),
              theirs: this.sideLabel(graph, branch, head),
            }
          : {
              ours: this.headLabel(graph),
              theirs: this.sideLabel(
                graph,
                kind === 'merge' ? (other?.name ?? null) : null,
                theirs,
              ),
            },
      message:
        kind === 'bisect'
          ? null
          : kind === 'merge'
            ? `Merge branch '${other?.name ?? 'feature'}'`
            : (history.commits[theirs ?? -1]?.summary ?? null),
      complete: done,
      skip: kind === 'merge' ? null : done,
      stopsAgain: kind === 'rebase' ? Math.min(stopsAgain, total - step) : 0,
    });
    if (kind === 'bisect') {
      // A bisect has no conflicts: only the banner.
      const wip = this.wip(repoId);
      const op = this.operations.get(repoId);
      if (wip && op) {
        for (const c of op.conflicts) wip.resolveConflict(c.path, c.ours);
        op.conflicts = [];
      }
    }
    const repo = this.find(repoId);
    const wip = this.wips.get(repoId);
    if (repo && wip) repo.state = { ...repo.state, dirty: wip.dirty() };
    this.watcherSaw(repoId, kind === 'rebase');
    return true;
  }

  /**
   * Makes the next interactive rebase of a repository stop on the scenario conflicts, at its
   * second kept commit (the first when there is only one). A repository whose path contains
   * `conflict` always does.
   */
  simulateRebaseConflict(repoId: number, on = true): void {
    if (on) this.rebaseConflicts.add(repoId);
    else this.rebaseConflicts.delete(repoId);
  }

  /**
   * Simulates a restart: the journal entries of a repository become entries of a previous
   * session (`restored`). With `pruned`, a `git gc` ran meanwhile: they lose what they need
   * and are refused with `undoObjectsMissing`.
   */
  simulateRestoredJournal(repoId: number, { pruned = false } = {}): void {
    const journal = this.journals.get(repoId);
    if (!journal) return;
    journal.restore();
    if (pruned) journal.prune();
    this.emit('journalChanged', { repoId });
  }

  /**
   * Makes the next pull of a repository that has diverged from its upstream (merge or rebase
   * strategy) stop on the scenario conflicts, as the backend's `pull_conflicts` does. A
   * repository whose path contains `conflict` always does.
   */
  simulatePullConflict(repoId: number, on = true): void {
    if (on) this.pullConflictRepos.add(repoId);
    else this.pullConflictRepos.delete(repoId);
  }

  /** Records a commit on HEAD (or rewrites HEAD for an amend) in the mock history. */
  private addCommit(repoId: number, summary: string, body: string, amend: boolean): string | null {
    const repo = this.find(repoId);
    const graph = this.graphs.get(repoId) ?? this.graph(repoId);
    if (!repo || !graph) return null;
    const { history } = graph;
    const head = graph.headCommit();
    if (amend && head !== null) {
      const amended = history.commits[head];
      if (!amended) return null;
      const sha = mockSha(0xa3, this.nextOpId++);
      Object.assign(amended, { sha, summary, body, commitTime: amended.commitTime + 60 });
      this.moveHead(repo, sha, 0);
      this.graphs.set(repoId, this.makeGraph(repoId, history));
      return sha;
    }
    const sha = mockSha(0xc0, history.commits.length);
    const time = (history.commits[head ?? -1]?.commitTime ?? MOCK_NOW) + 60;
    history.commits.push({
      sha,
      parents: head === null ? [] : [head],
      summary,
      body,
      authorName: 'Alex Martin',
      authorEmail: 'alex@example.com',
      authorTime: time,
      commitTime: time,
      files: ['README.md'],
      signature: null,
    });
    const commit = history.commits.length - 1;
    const current = history.head;
    if (current.kind === 'detached') {
      history.head = { kind: 'detached', commit };
    } else {
      const branch = history.local.find((b) => b.name === current.name);
      if (branch) branch.commit = commit;
      else history.local.push({ name: current.name, commit });
      history.head = { kind: 'branch', name: current.name };
    }
    this.moveHead(repo, sha, 1);
    this.graphs.set(repoId, this.makeGraph(repoId, history));
    return sha;
  }

  private moveHead(repo: MockRepo, sha: string, ahead: number): void {
    const { head } = repo.state;
    repo.state = {
      ...repo.state,
      head:
        head.kind === 'detached'
          ? { kind: 'detached', oid: sha }
          : { kind: 'branch', name: head.name, oid: sha },
    };
    if (repo.state.upstream) {
      repo.state = {
        ...repo.state,
        upstream: { ...repo.state.upstream, ahead: repo.state.upstream.ahead + ahead },
      };
    }
  }

  /** What the real watcher reports after a write, once its debounce elapsed. */
  private watcherSaw(repoId: number, refs: boolean): void {
    setTimeout(() => {
      if (refs) this.emit('refsChanged', { repoId });
      this.emit('statusChanged', { repoId });
    }, WATCH_DEBOUNCE_MS);
  }

  /** Working state of an open repository, created from its fixture on first use. */
  private wip(repoId: number): MockWip | null {
    const repo = this.find(repoId);
    if (!repo || !this.open.has(repoId)) return null;
    let wip = this.wips.get(repoId);
    if (!wip) {
      wip = MockWip.fromFixture(repo.known.name, repo.state.dirty);
      this.wips.set(repoId, wip);
    }
    return wip;
  }

  /**
   * Runs a write like the backend queue: `op-started`, the work (after `delayMs`, during
   * which `cancelOp` stops it), a command log entry, `op-finished`, then the watcher events.
   */
  private runWrite<T>(
    repoId: number,
    kind: OpKind,
    args: string[],
    work: () => { ok: T } | { error: YagguiError },
    {
      cancellable = false,
      delayMs = 0,
      refs = false,
      progress = false,
      steps,
      journal,
      journalError,
      note,
      logged = true,
    }: {
      cancellable?: boolean;
      delayMs?: number;
      refs?: boolean;
      /** Network phases (`Receiving objects`…) spread over `delayMs`. */
      progress?: boolean;
      /** Numbered steps spread over `delayMs` (`Rebasing (n/total)`). */
      steps?: { phase: string; total: number };
      /** How a success is journaled for the undo (`null`: it is not). */
      journal?: (result: T) => MockJournalSpec | null;
      /** How a failure is journaled anyway (a conflict that changed files). */
      journalError?: (error: YagguiError) => MockJournalSpec | null;
      /** `op-finished` note of a success that did not complete (paused, aborted). */
      note?: (result: T) => OpNote | null;
      /** A Git command, recorded in the log (a file save is not). */
      logged?: boolean;
    } = {},
  ): Promise<IpcResult<T>> {
    const repo = this.find(repoId);
    if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
    const opId = this.nextOpId++;
    let journaled = false;
    const run = (): { ok: T } | { error: YagguiError } => {
      const before = journal || journalError ? this.snapshot(repoId) : null;
      const result = work();
      const spec =
        'ok' in result ? (journal?.(result.ok) ?? null) : (journalError?.(result.error) ?? null);
      const after = spec ? this.snapshot(repoId) : null;
      if (spec && before && after) {
        let log = this.journals.get(repoId);
        if (!log) {
          log = new MockJournal();
          this.journals.set(repoId, log);
        }
        log.push(spec, before, after, Date.now());
        journaled = true;
      }
      journaled ||= (kind === 'undo' || kind === 'redo') && 'ok' in result;
      return result;
    };
    this.emit('opStarted', { repoId, opId, kind, cancellable });
    const timers: ReturnType<typeof setTimeout>[] = [];
    return new Promise((resolve) => {
      const finish = (result: { ok: T } | { error: YagguiError } | 'cancelled') => {
        timers.forEach(clearTimeout);
        this.runningOps.delete(opId);
        const failed = result !== 'cancelled' && 'error' in result ? result.error : null;
        if (logged)
          this.logCommand({
            repoId,
            args,
            cwd: repo.known.path,
            startedAt: MOCK_NOW,
            durationMs: delayMs + 8,
            exitCode: result === 'cancelled' ? null : failed ? 1 : 0,
            status: result === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'success',
            stdout: failed?.payload?.kind === 'hook' ? failed.payload.stdout : '',
            stderr:
              failed?.payload?.kind === 'hook' ? failed.payload.stderr : (failed?.detail ?? ''),
            truncated: false,
          });
        const wip = this.wips.get(repoId);
        if (wip) repo.state = { ...repo.state, dirty: wip.dirty() };
        if (result === 'cancelled') {
          this.emit('opFinished', { repoId, opId, kind, outcome: { kind: 'cancelled' } });
          resolve({
            status: 'error',
            error: mockError('cancelled', 'Operation cancelled.', 'Opération annulée.'),
          });
          return;
        }
        this.emit('opFinished', {
          repoId,
          opId,
          kind,
          outcome: failed
            ? { kind: 'failed', error: failed }
            : { kind: 'success', note: note && 'ok' in result ? note(result.ok) : null },
        });
        if (journaled) this.emit('journalChanged', { repoId });
        // An operation stopped on conflicts changed the working tree (and HEAD, in a rebase).
        if (!failed || failed.code === 'conflicts' || failed.code === 'emptyCommit') {
          this.watcherSaw(repoId, refs);
        }
        resolve(
          'error' in result
            ? { status: 'error', error: result.error }
            : { status: 'ok', data: result.ok },
        );
      };
      if (delayMs === 0) {
        finish(run());
        return;
      }
      timers.push(
        setTimeout(() => {
          finish(run());
        }, delayMs),
      );
      if (steps && steps.total > 0) {
        for (let step = 1; step <= steps.total; step++) {
          timers.push(
            setTimeout(
              () => {
                this.emit('opProgress', {
                  repoId,
                  opId,
                  phase: steps.phase,
                  percent: Math.round((step * 100) / steps.total),
                  current: step,
                  total: steps.total,
                  bytes: null,
                  bytesPerSec: null,
                });
              },
              (delayMs * (step - 1)) / steps.total,
            ),
          );
        }
      }
      if (progress) {
        const step = delayMs / MOCK_NETWORK_PHASES.length;
        MOCK_NETWORK_PHASES.forEach(([phase, percent], index) => {
          timers.push(
            setTimeout(() => {
              this.emit('opProgress', {
                repoId,
                opId,
                phase,
                percent,
                current: percent * 4,
                total: 400,
                bytes: percent * 52_000,
                bytesPerSec: 2_600_000,
              });
            }, step * index),
          );
        });
      }
      if (cancellable) {
        this.runningOps.set(opId, () => {
          timers.forEach(clearTimeout);
          finish('cancelled');
        });
      }
    });
  }

  private headSha(repoId: number): string {
    const graph = this.graph(repoId);
    const head = graph?.headCommit() ?? null;
    return head === null ? '' : (graph?.history.commits[head]?.sha ?? '');
  }

  /** Refs, HEAD commit and files of an open repository, for the undo journal. */
  private snapshot(repoId: number): MockSnapshot | null {
    const graph = this.graph(repoId);
    if (!graph) return null;
    const { history } = graph;
    const head = graph.headCommit();
    const commit = head === null ? undefined : history.commits[head];
    return {
      refs: structuredClone({
        local: history.local,
        tags: history.tags,
        stashes: history.stashes,
        head: history.head,
        worktrees: history.worktrees,
        remote: history.remote,
        remotes: history.remotes,
      }),
      lfsPatterns: this.modules.lfsPatterns(repoId),
      headCommit: head === null || !commit ? null : { index: head, commit: { ...commit } },
      wip: this.wip(repoId)?.copy() ?? null,
      refMap: mockRefs(history),
    };
  }

  /** Undo (back to `before`) or redo (forward to `after`) of the target journal record. */
  private undoWork(
    repoId: number,
    direction: 'undo' | 'redo',
  ): { ok: JournalEntry } | { error: YagguiError } {
    const log = this.journals.get(repoId);
    const record = direction === 'undo' ? log?.undoTarget() : log?.redoTarget();
    if (!log || !record) {
      return { error: direction === 'undo' ? nothingToUndo() : nothingToRedo() };
    }
    const block = MockJournal.block(record);
    if (block) return { error: undoBlocked(block) };
    const guard = this.historyGuard(repoId);
    if (guard) return { error: guard };
    const [from, to] =
      direction === 'undo' ? [record.after, record.before] : [record.before, record.after];
    return this.editHistory<JournalEntry>(repoId, (graph) => {
      const { history } = graph;
      const wip = this.wip(repoId);
      const moved = movedRefs(mockRefs(history), from.refMap, to.refMap);
      // Like the backend: a worktree the step removes must have no local changes.
      const op = record.entry.op;
      const leaving =
        op.kind === 'createWorktree' || op.kind === 'removeWorktree'
          ? history.worktrees.filter((w) => !to.refs.worktrees.some((t) => t.path === w.path))
          : [];
      const lost = leaving.filter((w) => this.modules.isWorktreeDirty(w.path));
      if (lost.length > 0) return { error: undoWouldOverwrite(lost.map((w) => w.path)) };
      // Like the backend: only the files changed since are listed.
      const changedFiles =
        record.files && wip && from.wip && wip.fingerprint() !== from.wip.fingerprint()
          ? wip.changedSince(from.wip)
          : null;
      if (moved.length > 0) return { error: undoDiverged(moved, []) };
      // Like the backend: files changed since would be overwritten.
      if (changedFiles && changedFiles.length > 0) {
        return { error: undoWouldOverwrite(changedFiles) };
      }
      let remotesChanged = false;
      for (const name of [...new Set([...from.refMap.keys(), ...to.refMap.keys()])]) {
        if (from.refMap.get(name) === to.refMap.get(name)) continue;
        if (name === 'HEAD') history.head = structuredClone(to.refs.head);
        else if (name.startsWith('refs/heads/')) {
          const short = name.slice('refs/heads/'.length);
          history.local = replaceRef(history.local, to.refs.local, short);
        } else if (name.startsWith('remote:')) remotesChanged = true;
        else {
          const short = name.slice('refs/tags/'.length);
          history.tags = replaceRef(history.tags, to.refs.tags, short);
        }
      }
      if (remotesChanged) {
        // Remotes come back with their tracking branches and the upstreams on them.
        history.remotes = structuredClone(to.refs.remotes);
        history.remote = structuredClone(to.refs.remote);
        for (const branch of history.local) {
          const then = to.refs.local.find((b) => b.name === branch.name);
          if (!then) continue;
          if (then.upstream === undefined) delete branch.upstream;
          else branch.upstream = then.upstream;
        }
      }
      // A dropped stash comes back on top (`git stash store`); a redo drops it again.
      const shas = (list: { sha: string }[]) => new Set(list.map((s) => s.sha));
      const [fromShas, toShas] = [shas(from.refs.stashes), shas(to.refs.stashes)];
      const back = to.refs.stashes.filter((s) => !fromShas.has(s.sha));
      history.stashes = [
        ...structuredClone(back),
        ...history.stashes.filter((s) => toShas.has(s.sha) || !fromShas.has(s.sha)),
      ];
      if (to.headCommit) history.commits[to.headCommit.index] = { ...to.headCommit.commit };
      if (op.kind === 'createWorktree' || op.kind === 'removeWorktree') {
        history.worktrees = structuredClone(to.refs.worktrees);
      }
      if (op.kind === 'lfsTrack') this.modules.setLfsPatterns(repoId, to.lfsPatterns);
      if (wip && to.wip) wip.restoreFrom(to.wip, record.files);
      if (direction === 'undo') log.markUndone(record);
      else log.markRedone(record);
      return { ok: { ...record.entry } };
    });
  }

  /** Applies a change to the history of an open repository and rebuilds its graph. */
  private editHistory<T>(
    repoId: number,
    edit: (graph: MockGraph, repo: MockRepo) => { ok: T } | { error: YagguiError },
  ): { ok: T } | { error: YagguiError } {
    const repo = this.find(repoId);
    const graph = this.graph(repoId);
    if (!repo || !graph) return { error: this.notOpen(repoId) };
    const result = edit(graph, repo);
    // A stop on conflicts moved HEAD too (a rebase detaches it on what it replayed).
    if (
      'ok' in result ||
      result.error.code === 'conflicts' ||
      result.error.code === 'emptyCommit'
    ) {
      this.graphs.set(repoId, this.makeGraph(repoId, graph.history));
      this.syncHead(repo, graph);
    }
    return result;
  }

  private remoteTagsOf(repoId: number): MockRemoteTags {
    let tags = this.remoteTags.get(repoId);
    if (!tags) {
      tags = new Map();
      this.remoteTags.set(repoId, tags);
    }
    return tags;
  }

  /** Remote names, `origin` first, as `git remote` lists them. */
  private remoteNames(graph: MockGraph): string[] {
    const names = new Set(graph.history.remotes.map((r) => r.name));
    for (const r of graph.history.remote) {
      const split = splitRemoteBranch(graph.history, r.name);
      if (split) names.add(split.remote);
    }
    return [...names].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
  }

  /** `RepoState.head` / `upstream` from the mock history, after a ref change. */
  private syncHead(repo: MockRepo, graph: MockGraph): void {
    const { history } = graph;
    const head = graph.headCommit();
    const sha = head === null ? '' : (history.commits[head]?.sha ?? '');
    if (history.head.kind === 'detached') {
      repo.state = { ...repo.state, head: { kind: 'detached', oid: sha }, upstream: null };
      return;
    }
    const name = history.head.name;
    const branch = history.local.find((b) => b.name === name);
    const remote = history.remote.find((r) => r.name === branch?.upstream);
    repo.state = {
      ...repo.state,
      head: branch ? { kind: 'branch', name, oid: sha } : { kind: 'unborn', name },
      upstream:
        branch?.upstream === undefined
          ? null
          : {
              name: branch.upstream,
              ahead: remote ? countExclusive(history, branch.commit, remote.commit) : 0,
              behind: remote ? countExclusive(history, remote.commit, branch.commit) : 0,
              gone: !remote,
            },
    };
  }

  private refNameError(graph: MockGraph, kind: RefNameKind, name: string): YagguiError | null {
    if (!isValidRefName(name)) return invalidRefName(name, kind);
    const { history } = graph;
    const taken =
      kind === 'tag'
        ? history.tags.some((t) => t.name === name)
        : history.local.some((b) => b.name === name);
    return taken ? refExists(name, kind) : null;
  }

  /** The stash `id` designates, or `staleRefs` when the list changed since it was read. */
  private findStash(graph: MockGraph, id: StashId): YagguiError | null {
    return graph.history.stashes[id.index]?.sha === id.sha ? null : staleRefs();
  }

  /**
   * Moves HEAD to `commit` (branch `name`, or detached), with the local changes handled
   * by `mode`. A target name containing `conflict` simulates changes that cannot be carried;
   * `pop-conflict`, a stash-checkout-pop whose pop conflicts.
   */
  private moveTo(
    graph: MockGraph,
    repoId: number,
    target: { branch: string } | { commit: number },
    label: string,
    mode: CheckoutMode,
  ): { ok: null } | { error: YagguiError } {
    const { history } = graph;
    const wip = this.wip(repoId);
    if (!wip) return { error: this.notOpen(repoId) };
    if (wip.hasConflicts()) return { error: unresolvedConflicts() };
    const changed = wip.trackedChanges();
    const canCarry = !/conflict/.test(label);
    if (changed.length > 0) {
      if (mode === 'clean') return { error: dirtyWorktree(canCarry ? [] : changed, canCarry) };
      if (mode === 'carry' && !canCarry) return { error: dirtyWorktree(changed, false) };
    }
    let stashed: string | null = null;
    if (mode === 'stashAndPop' && changed.length > 0) {
      stashed = this.pushStash(graph, wip, null, true, false);
    }
    history.head =
      'branch' in target
        ? { kind: 'branch', name: target.branch }
        : { kind: 'detached', commit: target.commit };
    if (stashed !== null) {
      if (/pop-conflict/.test(label)) {
        wip.markConflicted(changed.slice(0, 1));
        return { error: stashConflict(changed.slice(0, 1), stashed, true) };
      }
      this.popStash(graph, wip, 0);
    }
    return { ok: null };
  }

  /** Records a stash of the current changes; returns its SHA, `null` when nothing to stash. */
  private pushStash(
    graph: MockGraph,
    wip: MockWip,
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
  ): string | null {
    const hasUntracked = wip.changes('unstaged').some((c) => c.status === 'untracked');
    const saved = wip.stash(includeUntracked, keepIndex);
    if (!saved) return null;
    const { history } = graph;
    const base = graph.headCommit() ?? 0;
    const sha = mockSha(0x57a5, 1000 + this.nextOpId++);
    const where = history.head.kind === 'branch' ? history.head.name : '(no branch)';
    const summary = history.commits[base]?.summary ?? '';
    history.stashes.unshift({
      sha,
      base,
      // Git only adds the third parent when untracked files were stashed.
      untrackedSha: includeUntracked && hasUntracked ? mockSha(0x57a6, 1000 + this.nextOpId) : null,
      message: message?.trim()
        ? `On ${where}: ${message.trim()}`
        : `WIP on ${where}: ${(history.commits[base]?.sha ?? '').slice(0, 7)} ${summary}`,
    });
    this.stashStates.set(sha, saved);
    return sha;
  }

  /** Applies stash `index` to the working tree, then drops it. */
  private popStash(graph: MockGraph, wip: MockWip, index: number): StashEntryInfo {
    const [entry] = graph.history.stashes.splice(index, 1);
    const saved = entry ? this.stashStates.get(entry.sha) : undefined;
    if (saved) wip.applyStash(saved);
    return { sha: entry?.sha ?? '', message: entry?.message ?? '' };
  }

  /** Applies stash `id`, kept or dropped. A message containing `conflict` conflicts. */
  private applyStashWork(
    graph: MockGraph,
    repoId: number,
    id: StashId,
    drop: boolean,
  ): { ok: StashEntryInfo } | { error: YagguiError } {
    const stale = this.findStash(graph, id);
    if (stale) return { error: stale };
    const wip = this.wip(repoId);
    const entry = graph.history.stashes[id.index];
    if (!wip || !entry) return { error: this.notOpen(repoId) };
    if (/conflict/.test(entry.message)) {
      const paths = ['src/app/App.tsx'];
      wip.markConflicted(paths);
      return { error: stashConflict(paths, entry.sha, false) };
    }
    if (drop) return { ok: this.popStash(graph, wip, id.index) };
    const saved = this.stashStates.get(entry.sha);
    if (saved) wip.applyStash(saved);
    return { ok: { sha: entry.sha, message: entry.message } };
  }

  private checkoutWork(
    repoId: number,
    target: CheckoutTarget,
    mode: CheckoutMode,
  ): { ok: CheckoutResult } | { error: YagguiError } {
    return this.editHistory<CheckoutResult>(repoId, (graph) => {
      const { history } = graph;
      if (target.kind === 'detached') {
        const commit = graph.resolve(target.rev);
        if (commit === null) return { error: this.revisionNotFound(target.rev) };
        const moved = this.moveTo(graph, repoId, { commit }, target.rev, mode);
        return 'error' in moved
          ? moved
          : { ok: { branch: null, created: false, fastForwarded: null } };
      }
      if (target.kind === 'branch') {
        if (!history.local.some((b) => b.name === target.name)) {
          return { error: this.revisionNotFound(target.name) };
        }
        const other = history.worktrees.find(
          (w) => !w.isCurrent && w.head?.kind === 'branch' && w.head.name === target.name,
        );
        if (other) return { error: branchInOtherWorktree(target.name, other.path) };
        const moved = this.moveTo(graph, repoId, { branch: target.name }, target.name, mode);
        return 'error' in moved
          ? moved
          : { ok: { branch: target.name, created: false, fastForwarded: null } };
      }
      const remote = history.remote.find((b) => b.name === target.name);
      const split = splitRemoteBranch(history, target.name);
      if (!remote || !split) return { error: this.revisionNotFound(target.name) };
      const existing = history.local.find((b) => b.name === split.branch);
      if (!existing) {
        if (!isValidRefName(split.branch)) return { error: invalidRefName(split.branch, 'branch') };
        history.local.push({ name: split.branch, commit: remote.commit, upstream: remote.name });
      }
      // A local branch behind the remote one catches up with it, like the backend's
      // `merge --ff-only`; ahead or diverged, it stays.
      const before = existing?.commit;
      const behind =
        existing !== undefined &&
        existing.commit !== remote.commit &&
        ancestors(history.commits, remote.commit).has(existing.commit);
      if (behind) existing.commit = remote.commit;
      const moved = this.moveTo(graph, repoId, { branch: split.branch }, target.name, mode);
      if ('error' in moved && moved.error.code !== 'stashConflict') {
        if (!existing) history.local = history.local.filter((b) => b.name !== split.branch);
        if (existing && before !== undefined) existing.commit = before;
        return moved;
      }
      return 'error' in moved
        ? moved
        : {
            ok: {
              branch: split.branch,
              created: !existing,
              fastForwarded: behind ? remote.name : null,
            },
          };
    });
  }

  private createBranchWork(
    repoId: number,
    name: string,
    from: BranchStart,
    checkout: boolean,
  ): { ok: null } | { error: YagguiError } {
    return this.editHistory<null>(repoId, (graph) => {
      const { history } = graph;
      const invalid = this.refNameError(graph, 'branch', name);
      if (invalid) return { error: invalid };
      if (from.kind === 'stash') return this.stashBranchWork(graph, repoId, from.stash, name);
      const rev = from.kind === 'head' ? 'HEAD' : from.kind === 'commit' ? from.sha : from.fullName;
      const commit = graph.resolve(rev);
      if (commit === null) return { error: this.revisionNotFound(rev) };
      const upstream =
        from.kind === 'ref' && from.fullName.startsWith('refs/remotes/')
          ? from.fullName.slice('refs/remotes/'.length)
          : undefined;
      history.local.push({ name, commit, ...(upstream ? { upstream } : {}) });
      if (!checkout) return { ok: null };
      const moved = this.moveTo(graph, repoId, { branch: name }, name, 'carry');
      if ('error' in moved) history.local = history.local.filter((b) => b.name !== name);
      return moved;
    });
  }

  private stashBranchWork(
    graph: MockGraph,
    repoId: number,
    id: StashId,
    name: string,
  ): { ok: null } | { error: YagguiError } {
    const invalid = this.refNameError(graph, 'branch', name) ?? this.findStash(graph, id);
    if (invalid) return { error: invalid };
    const entry = graph.history.stashes[id.index];
    const wip = this.wip(repoId);
    if (!entry || !wip) return { error: this.notOpen(repoId) };
    if (wip.trackedChanges().length > 0)
      return { error: dirtyWorktree(wip.trackedChanges(), false) };
    graph.history.local.push({ name, commit: entry.base });
    graph.history.head = { kind: 'branch', name };
    this.popStash(graph, wip, id.index);
    return { ok: null };
  }

  private commitWork(
    repoId: number,
    request: CommitRequest,
  ): { ok: { sha: string } } | { error: YagguiError } {
    const repo = this.find(repoId);
    const wip = this.wip(repoId);
    if (!repo || !wip) return { error: this.notOpen(repoId) };
    const summary = request.summary.trim();
    if (!summary) {
      return {
        error: mockError(
          'invalidArgument',
          'The commit summary is empty.',
          'Le résumé du commit est vide.',
        ),
      };
    }
    if (wip.hasConflicts()) return { error: unresolvedConflicts() };
    const identity = this.identity(repoId);
    if (!identity.name || !identity.email) {
      return {
        error: {
          ...mockError(
            'identityUnknown',
            'Git does not know who you are: set your name and email (user.name, user.email) to commit.',
            'Git ne sait pas qui tu es : renseigne ton nom et ton e-mail (user.name, user.email) pour commiter.',
          ),
          action: { kind: 'configureIdentity', repoId },
        },
      };
    }
    const unborn = repo.state.head.kind === 'unborn';
    if (request.amend && unborn) {
      return {
        error: mockError(
          'invalidArgument',
          'There is no commit to amend yet.',
          "Il n'y a pas encore de commit à modifier.",
        ),
      };
    }
    if (!request.amend && wip.changes('staged').length === 0) {
      return {
        error: mockError(
          'nothingToCommit',
          'Nothing to commit: stage changes first.',
          "Rien à commiter : stage d'abord des modifications.",
        ),
      };
    }
    // A summary containing `[hook-fail]` simulates a pre-commit hook rejecting the commit.
    if (!request.skipHooks && summary.includes('[hook-fail]')) {
      const stdout = 'Running lint-staged…\n✖ eslint --fix found 2 problems\n';
      const stderr =
        "src/app/RepoView.tsx\n  12:7  error  'unused' is assigned a value but never used  no-unused-vars\n  40:1  error  Missing return type  explicit-function-return-type\n\n✖ 2 problems (2 errors, 0 warnings)\n";
      return {
        error: {
          ...mockError(
            'hookFailed',
            'The pre-commit hook rejected the commit. Its output explains why.',
            'Le hook pre-commit a refusé le commit. Sa sortie explique pourquoi.',
          ),
          payload: {
            kind: 'hook',
            hook: 'pre-commit',
            exitCode: 1,
            stdout,
            stderr,
            truncated: false,
          },
        },
      };
    }
    const sha = this.addCommit(repoId, summary, request.description.trim(), request.amend);
    if (sha === null) return { error: this.notOpen(repoId) };
    wip.commit();
    return { ok: { sha } };
  }

  /** A repository path containing `no-identity` simulates a Git without user.name/email. */
  private identity(repoId: number): GitIdentity {
    const set = this.identities.get(repoId) ?? this.globalIdentity;
    if (set) return { ...set };
    const repo = this.find(repoId);
    if (repo && /no-identity/.test(repo.known.path)) return { name: null, email: null };
    return { name: 'Alex Martin', email: 'alex@example.com' };
  }

  private nextGraphVersion(repoId: number): number {
    const version = (this.graphVersions.get(repoId) ?? 0) + 1;
    this.graphVersions.set(repoId, version);
    return version;
  }

  /** The graph of an open repository, generated on first use. */
  private makeGraph(repoId: number, history: MockHistory): MockGraph {
    const filter = this.graphFilters.get(repoId) ?? null;
    return new MockGraph(history, this.nextGraphVersion(repoId), filter);
  }

  private graph(repoId: number): MockGraph | null {
    const repo = this.find(repoId);
    if (!repo || !this.open.has(repoId)) return null;
    let graph = this.graphs.get(repoId);
    if (!graph) {
      const history = createMockHistory(
        repoId,
        repo.known.path,
        repo.state.head,
        repo.state.upstream,
        MOCK_NOW - 600,
      );
      graph = this.makeGraph(repoId, history);
      this.graphs.set(repoId, graph);
    }
    return graph;
  }

  private hunks(
    repoId: number,
    op: 'stage' | 'unstage' | 'discard',
    change: HunkChange,
  ): { ok: null } | { error: YagguiError } {
    const wip = this.wip(repoId);
    return wip ? wip.applyHunks(op, change) : { error: this.notOpen(repoId) };
  }

  private revisionNotFound(rev: string): YagguiError {
    return mockError(
      'revisionNotFound',
      `No commit matches "${rev}".`,
      `Aucun commit ne correspond à « ${rev} ».`,
    );
  }

  private find(repoId: number): MockRepo | undefined {
    return this.repos.find((repo) => repo.known.id === repoId);
  }

  /** A repo first seen at `path` (`open_repo` of a new folder, import). */
  private newRepo(path: string): MockRepo {
    return {
      known: {
        id: Math.max(0, ...this.repos.map((r) => r.known.id)) + 1,
        path,
        name: folderName(path),
        favorite: false,
        lastOpenedAt: MOCK_NOW,
        exists: true,
      },
      state: {
        // A path containing `unborn` simulates a fresh `git init` (no commit yet).
        head: /unborn/.test(path)
          ? { kind: 'unborn', name: 'main' }
          : { kind: 'branch', name: 'main', oid: 'c0ffee0000000000000000000000000000000000' },
        upstream: null,
        dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        operation: null,
        indexLock: null,
      },
      // A path containing `no-watch` simulates a repository the watcher could not follow.
      watchError: /no-watch/.test(path)
        ? {
            ...mockError(
              'watchUnavailable',
              'The repository files cannot be watched (too many watched files).',
              'Les fichiers du dépôt ne peuvent pas être surveillés (trop de fichiers surveillés).',
            ),
            detail: 'inotify watch limit reached (fs.inotify.max_user_watches)',
          }
        : null,
    };
  }

  private unknownRepo(repoId: number): YagguiError {
    return mockError(
      'invalidArgument',
      `Unknown repository #${repoId}.`,
      `Dépôt n°${repoId} inconnu.`,
    );
  }

  /** Worktree root at `path`, as `RepoManager::locate` checks it. */
  private locate(path: string): { path: string } | { error: YagguiError } {
    const normalized = path.trim().replace(/(.)[\\/]+$/, '$1');
    if (!normalized || !isAbsolute(normalized)) return { error: invalidPath(path) };
    if (/missing/.test(normalized)) {
      return {
        error: mockError(
          'repoNotFound',
          `The folder ${path} does not exist.`,
          `Le dossier ${path} n'existe pas.`,
        ),
      };
    }
    if (/not-a-repo/.test(normalized)) {
      return {
        error: mockError(
          'notARepository',
          `${normalized} is not a Git repository.`,
          `${normalized} n'est pas un dépôt Git.`,
        ),
      };
    }
    return { path: normalized };
  }

  private addMembers(workspace: Workspace, repoIds: readonly number[]): void {
    for (const id of repoIds) {
      if (this.find(id) && !workspace.repoIds.includes(id)) workspace.repoIds.push(id);
    }
  }

  private info(repo: MockRepo): RepoInfo {
    return {
      id: repo.known.id,
      path: repo.known.path,
      name: repo.known.name,
      state: structuredClone(repo.state),
      watchError: repo.watchError ?? null,
    };
  }

  private notOpen(repoId: number): YagguiError {
    return mockError(
      'repoNotOpen',
      `Repository #${repoId} is not open.`,
      `Le dépôt n°${repoId} n'est pas ouvert.`,
    );
  }

  // --- History operations (M3-1) ---------------------------------------------------------

  /**
   * Whether a history operation stops on conflicts: the repository path or the name of what
   * is merged / rebased / picked contains `conflict`.
   */
  /** Cherry-pick / revert of a commit already applied: a repo path or name with `empty`. */
  private emptyTriggered(repoId: number, name: string): boolean {
    return /empty/.test(this.find(repoId)?.known.path ?? '') || /empty/.test(name);
  }

  /**
   * Local changes Git would refuse to overwrite: tracked changes to files the incoming
   * commits touch (`dirtyWorktree`, as the backend maps "would be overwritten"). Only in a
   * repo whose path contains `overwrite`: the files of the mock commits are synthetic, and
   * the demo repositories keep merging over their work in progress.
   */
  private overwrittenBy(repoId: number, graph: MockGraph, incoming: number[]): string[] {
    if (!/overwrite/.test(this.find(repoId)?.known.path ?? '')) return [];
    const tracked = this.wip(repoId)?.trackedChanges() ?? [];
    if (tracked.length === 0) return [];
    const touched = new Set(incoming.flatMap((c) => graph.history.commits[c]?.files ?? []));
    return tracked.filter((path) => touched.has(path));
  }

  /**
   * A cherry-pick or revert whose commit brings nothing any more: stays in progress with no
   * conflict, `emptyCommit` (skip it, or continue once something is staged).
   */
  private stopEmpty(
    repoId: number,
    graph: MockGraph,
    commit: number,
    op: Omit<MockOperation, 'conflicts'>,
  ): YagguiError {
    const repo = this.find(repoId);
    if (!repo) return this.notOpen(repoId);
    this.operations.set(repoId, { ...op, conflicts: [], empty: true });
    repo.state = { ...repo.state, operation: op.operation };
    return emptyCommit(graph.history.commits[commit]?.sha ?? null);
  }

  private conflictTriggered(repoId: number, name: string): boolean {
    return /conflict/.test(this.find(repoId)?.known.path ?? '') || /conflict/.test(name);
  }

  private commitSha(graph: MockGraph, commit: number | null): string {
    return commit === null ? '' : (graph.history.commits[commit]?.sha ?? '');
  }

  /** Appends a commit to the mock history; returns its index. */
  private newCommit(graph: MockGraph, parents: number[], summary: string, body = ''): number {
    const { commits } = graph.history;
    const time = Math.max(MOCK_NOW, ...parents.map((p) => commits[p]?.commitTime ?? MOCK_NOW)) + 60;
    commits.push({
      sha: mockSha(0xb1, commits.length + 7 * this.nextOpId++),
      parents,
      summary,
      body,
      authorName: 'Alex Martin',
      authorEmail: 'alex@example.com',
      authorTime: time,
      commitTime: time,
      files: ['README.md'],
      signature: null,
    });
    return commits.length - 1;
  }

  /** Moves the current branch (or the detached HEAD) to `commit`. */
  private setHead(graph: MockGraph, commit: number): void {
    const { history } = graph;
    const { head } = history;
    if (head.kind === 'branch') {
      const branch = history.local.find((b) => b.name === head.name);
      if (branch) branch.commit = commit;
      else history.local.push({ name: head.name, commit });
    } else {
      history.head = { kind: 'detached', commit };
    }
  }

  private historyResult(
    graph: MockGraph,
    effect: HistoryResult['effect'],
    previous: number | null,
  ): HistoryResult {
    return {
      effect,
      head: this.commitSha(graph, graph.headCommit()),
      previousHead: previous === null ? null : this.commitSha(graph, previous),
    };
  }

  private sideLabel(graph: MockGraph, branch: string | null, commit: number | null): SideLabel {
    const c = commit === null ? undefined : graph.history.commits[commit];
    return { branch, commit: c ? { sha: c.sha, summary: c.summary } : null };
  }

  /** Label of HEAD: its branch (when not detached) and commit. */
  private headLabel(graph: MockGraph): SideLabel {
    const { head } = graph.history;
    return this.sideLabel(graph, head.kind === 'branch' ? head.name : null, graph.headCommit());
  }

  /** Branch names pointing to `commit`, local first: how a merged commit is named. */
  private branchAt(graph: MockGraph, commit: number): string | null {
    const { history } = graph;
    return (
      history.local.find((b) => b.commit === commit)?.name ??
      history.remote.find((b) => b.commit === commit)?.name ??
      null
    );
  }

  /** Before any history operation: no operation in progress, no conflict left. */
  private historyGuard(repoId: number): YagguiError | null {
    const repo = this.find(repoId);
    const wip = this.wip(repoId);
    if (!repo || !wip) return this.notOpen(repoId);
    if (repo.state.operation || this.operations.has(repoId)) return operationInProgress();
    if (wip.hasConflicts()) return unresolvedConflicts();
    return null;
  }

  /**
   * Stops an operation on the scenario conflicts: they go to the working tree, the
   * operation shows in `repoState`, and the call fails with `conflicts`.
   */
  private stopOnConflicts(
    repoId: number,
    op: Omit<MockOperation, 'conflicts'>,
    { pull = false }: { pull?: boolean } = {},
  ): YagguiError {
    const repo = this.find(repoId);
    const wip = this.wip(repoId);
    if (!repo || !wip) return this.notOpen(repoId);
    const conflicts = scenarioConflicts();
    for (const conflict of conflicts) {
      wip.setConflict(conflict.path, conflict.ours, mergedText(conflict, op.labels));
    }
    this.operations.set(repoId, { ...op, conflicts });
    repo.state = { ...repo.state, operation: op.operation };
    return conflictsError(
      op.operation,
      conflicts.map((c) => c.path),
      pull,
    );
  }

  /**
   * A diverged merge or rebase pull in a repo whose path (or upstream) says `conflict`:
   * stops like `merge` / `rebase` do, with the same error (the backend's `pull_conflicts`).
   */
  private pullConflicts(
    repoId: number,
    graph: MockGraph,
    strategy: 'merge' | 'rebase',
    branch: { name: string; commit: number },
    remote: { name: string; commit: number },
  ): YagguiError {
    const { history } = graph;
    const previous = branch.commit;
    const name = branch.name;
    if (strategy === 'merge') {
      const message = `Merge branch '${remote.name.split('/').slice(1).join('/')}'`;
      return this.stopOnConflicts(
        repoId,
        {
          operation: { kind: 'merge', squash: false },
          labels: {
            ours: this.headLabel(graph),
            theirs: this.sideLabel(graph, remote.name, remote.commit),
          },
          message,
          complete: (g, text) => {
            const [summary = '', ...body] = (text?.trim() ? text.trim() : message).split('\n');
            this.setHead(g, this.newCommit(g, [previous, remote.commit], summary, body.join('\n')));
            return this.historyResult(g, 'commits', previous);
          },
          skip: null,
          stopsAgain: 0,
        },
        { pull: true },
      );
    }
    const picked = this.toReplay(graph, previous, remote.commit);
    const first = picked[0] ?? previous;
    const finish = (g: MockGraph, skipFirst: boolean, message: string | null) => {
      g.history.head = { kind: 'detached', commit: remote.commit };
      this.replay(g, skipFirst ? picked.slice(1) : picked, skipFirst ? null : message);
      const moved = g.history.local.find((b) => b.name === name);
      if (moved) moved.commit = g.headCommit() ?? remote.commit;
      g.history.head = { kind: 'branch', name };
      return this.historyResult(g, 'commits', previous);
    };
    history.head = { kind: 'detached', commit: remote.commit };
    return this.stopOnConflicts(
      repoId,
      {
        operation: {
          kind: 'rebase',
          interactive: true,
          step: 1,
          total: Math.max(picked.length, 1),
          headName: name,
        },
        labels: {
          ours: this.sideLabel(graph, remote.name, remote.commit),
          theirs: this.sideLabel(graph, name, first),
        },
        message: history.commits[first]?.summary ?? null,
        complete: (g, message) => finish(g, false, message),
        skip: (g) => finish(g, true, null),
        stopsAgain: 0,
      },
      { pull: true },
    );
  }

  /** The operation in progress; one recorded in the fixture state is adopted on first use. */
  private operation(repoId: number): MockOperation | null {
    const existing = this.operations.get(repoId);
    if (existing) return existing;
    const repo = this.find(repoId);
    const graph = this.graph(repoId);
    const wip = this.wip(repoId);
    const operation = repo?.state.operation;
    if (!repo || !graph || !wip || !operation) return null;
    const head = graph.headCommit();
    const headName = operation.kind === 'rebase' ? operation.headName : null;
    const conflicts: MockConflict[] = wip.conflictedPaths().map((path) => ({
      path,
      kind: 'content',
      binary: false,
      resolved: false,
      base: 'int value = 0;\n',
      ours: 'int value = 1;\n',
      theirs: 'int value = 2;\n',
    }));
    const adopted: MockOperation = {
      operation,
      labels:
        operation.kind === 'rebase'
          ? {
              ours: this.sideLabel(graph, null, head),
              theirs: this.sideLabel(graph, headName, head),
            }
          : { ours: this.headLabel(graph), theirs: this.sideLabel(graph, null, null) },
      message: operation.kind === 'bisect' ? null : 'Resolve the scheduler conflicts',
      conflicts,
      complete: (g) => {
        const tip = g.headCommit();
        if (headName && tip !== null) {
          const branch = g.history.local.find((b) => b.name === headName);
          if (branch) branch.commit = tip;
          else g.history.local.push({ name: headName, commit: tip });
          g.history.head = { kind: 'branch', name: headName };
        }
        return this.historyResult(g, 'commits', head);
      },
      skip: operation.kind === 'merge' ? null : (g) => this.historyResult(g, 'commits', head),
      stopsAgain: 0,
    };
    this.operations.set(repoId, adopted);
    return adopted;
  }

  private endOperation(repoId: number): void {
    this.operations.delete(repoId);
    const repo = this.find(repoId);
    if (repo) repo.state = { ...repo.state, operation: null };
  }

  /** `OpKind` of the queued continue / skip / abort of an operation. */
  /** Like the backend: a continue or skip that leaves a rebase in progress is "paused". */
  private pausedNote(repoId: number): OpNote | null {
    return this.operation(repoId)?.operation.kind === 'rebase' ? 'paused' : null;
  }

  private operationKind(operation: RepoOperation): OpKind {
    switch (operation.kind) {
      case 'merge':
        return 'merge';
      case 'rebase':
        return 'rebase';
      case 'cherryPick':
        return 'cherryPick';
      case 'revert':
        return 'revert';
      case 'applyMailbox':
        return 'applyMailbox';
      case 'bisect':
        return 'bisect';
    }
  }

  private mergeWork(
    repoId: number,
    request: MergeRequest,
  ): { ok: HistoryResult } | { error: YagguiError } {
    return this.editHistory<HistoryResult>(repoId, (graph) => {
      const guard = this.historyGuard(repoId);
      if (guard) return { error: guard };
      const { history } = graph;
      const head = graph.headCommit();
      const source = graph.resolve(request.source);
      if (source === null) return { error: this.revisionNotFound(request.source) };
      if (head === null) {
        return {
          error: invalidHistoryArgument(
            'There is no commit to merge into yet.',
            "Il n'y a pas encore de commit dans lequel merger.",
          ),
        };
      }
      if (ancestors(history.commits, head).has(source)) {
        return { ok: this.historyResult(graph, 'upToDate', head) };
      }
      const canFastForward = ancestors(history.commits, source).has(head);
      if (request.mode === 'fastForwardOnly' && !canFastForward) {
        return { error: mergeNotFastForward(request.source) };
      }
      if (this.wip(repoId)?.trackedChanges().length) {
        const own = ancestors(history.commits, head);
        const incoming = [...ancestors(history.commits, source)].filter((c) => !own.has(c));
        const blocked = this.overwrittenBy(repoId, graph, incoming);
        if (blocked.length > 0) return { error: localChanges('merge', blocked) };
      }
      const name = this.branchAt(graph, source) ?? request.source;
      const message = request.message?.trim()
        ? request.message.trim()
        : request.mode === 'squash'
          ? `Squashed commit of the following:\n\n${history.commits[source]?.summary ?? ''}`
          : `Merge branch '${name}'`;
      const squash = request.mode === 'squash';
      const commit = (g: MockGraph, text: string): HistoryResult => {
        const [summary = '', ...body] = text.split('\n');
        const parents = squash ? [head] : [head, source];
        this.setHead(g, this.newCommit(g, parents, summary, body.join('\n').trim()));
        return this.historyResult(g, 'commits', head);
      };
      if (this.conflictTriggered(repoId, request.source) && request.mode !== 'fastForwardOnly') {
        return {
          error: this.stopOnConflicts(repoId, {
            operation: { kind: 'merge', squash },
            labels: { ours: this.headLabel(graph), theirs: this.sideLabel(graph, name, source) },
            message,
            complete: (g, text) => commit(g, text?.trim() ? text.trim() : message),
            skip: null,
            stopsAgain: 0,
          }),
        };
      }
      if (canFastForward && request.mode !== 'noFastForward' && !squash) {
        this.setHead(graph, source);
        return { ok: this.historyResult(graph, 'fastForward', head) };
      }
      return { ok: commit(graph, message) };
    });
  }

  /** Commits of `tip` missing from `onto`, oldest first (graph order), merges dropped. */
  private toReplay(graph: MockGraph, tip: number, onto: number): number[] {
    const { commits } = graph.history;
    const base = ancestors(commits, onto);
    return [...ancestors(commits, tip)]
      .filter((c) => !base.has(c) && (commits[c]?.parents.length ?? 0) < 2)
      .sort((a, b) => (graph.rowOfCommit(b) ?? 0) - (graph.rowOfCommit(a) ?? 0));
  }

  /** Copies `picked` on top of HEAD; the first one takes `message` when given. */
  private replay(graph: MockGraph, picked: number[], message: string | null): void {
    picked.forEach((c, i) => {
      const original = graph.history.commits[c];
      const head = graph.headCommit();
      if (!original || head === null) return;
      const [summary = '', ...body] = (
        i === 0 && message?.trim() ? message.trim() : `${original.summary}\n${original.body}`
      ).split('\n');
      this.setHead(graph, this.newCommit(graph, [head], summary, body.join('\n').trim()));
    });
  }

  /** What `rebase` would replay, for its progress; `null` when it cannot start. */
  private rebaseSteps(repoId: number, request: RebaseRequest): number | null {
    const graph = this.graph(repoId);
    if (!graph) return null;
    const { head } = graph.history;
    const name = request.branch ?? (head.kind === 'branch' ? head.name : null);
    const tip = graph.history.local.find((b) => b.name === name)?.commit;
    const onto = graph.resolve(request.onto);
    if (tip === undefined || onto === null) return null;
    return this.toReplay(graph, tip, onto).length;
  }

  private rebaseWork(
    repoId: number,
    request: RebaseRequest,
  ): { ok: HistoryResult } | { error: YagguiError } {
    return this.editHistory<HistoryResult>(repoId, (graph) => {
      const guard = this.historyGuard(repoId);
      if (guard) return { error: guard };
      const wip = this.wip(repoId);
      if (!wip) return { error: this.notOpen(repoId) };
      const { history } = graph;
      const name = request.branch ?? (history.head.kind === 'branch' ? history.head.name : null);
      if (name === null) return { error: detachedHead() };
      const branch = history.local.find((b) => b.name === name);
      if (!branch) return { error: this.revisionNotFound(name) };
      const onto = graph.resolve(request.onto);
      if (onto === null) return { error: this.revisionNotFound(request.onto) };
      const tracked = wip.trackedChanges();
      if (tracked.length > 0) return { error: localChanges('rebase', tracked) };
      const previous = branch.commit;
      history.head = { kind: 'branch', name };
      if (ancestors(history.commits, previous).has(onto)) {
        return { ok: this.historyResult(graph, 'upToDate', previous) };
      }
      const picked = this.toReplay(graph, previous, onto);
      if (this.conflictTriggered(repoId, `${name} ${request.onto}`)) {
        const total = Math.max(picked.length, 1);
        const first = picked[0] ?? previous;
        // While rebasing, HEAD is detached on the commits already replayed.
        history.head = { kind: 'detached', commit: onto };
        const again = /conflict-again/.test(this.find(repoId)?.known.path ?? '') ? 1 : 0;
        const finish = (g: MockGraph, skipFirst: boolean, message: string | null) => {
          g.history.head = { kind: 'detached', commit: onto };
          this.replay(g, skipFirst ? picked.slice(1) : picked, skipFirst ? null : message);
          const tip = g.headCommit() ?? onto;
          const moved = g.history.local.find((b) => b.name === name);
          if (moved) moved.commit = tip;
          g.history.head = { kind: 'branch', name };
          return this.historyResult(g, 'commits', previous);
        };
        return {
          error: this.stopOnConflicts(repoId, {
            operation: { kind: 'rebase', interactive: true, step: 1, total, headName: name },
            labels: {
              ours: this.sideLabel(graph, this.branchAt(graph, onto) ?? request.onto, onto),
              theirs: this.sideLabel(graph, name, first),
            },
            message: history.commits[first]?.summary ?? null,
            complete: (g, message) => finish(g, false, message),
            skip: (g) => finish(g, true, null),
            stopsAgain: Math.min(again, total - 1),
          }),
        };
      }
      history.head = { kind: 'detached', commit: onto };
      this.replay(graph, picked, null);
      branch.commit = graph.headCommit() ?? onto;
      history.head = { kind: 'branch', name };
      // Nothing to replay: the branch only moved to `onto`.
      const effect = picked.length === 0 ? 'fastForward' : 'commits';
      return { ok: this.historyResult(graph, effect, previous) };
    });
  }

  /**
   * Interactive rebase of the mock (M3-4). Stops on the first `edit` (later ones are picked:
   * a mock limitation) or, when triggered, on the scenario conflicts.
   */
  private interactiveWork(
    repoId: number,
    base: string,
    todo: RebaseTodoEntry[],
  ): { ok: InteractiveRebaseResult } | { error: YagguiError } {
    return this.editHistory<InteractiveRebaseResult>(repoId, (graph) => {
      const guard = this.historyGuard(repoId);
      if (guard) return { error: guard };
      const wip = this.wip(repoId);
      const repo = this.find(repoId);
      if (!wip || !repo) return { error: this.notOpen(repoId) };
      const { history } = graph;
      const previous = graph.headCommit();
      if (previous === null) return { error: noCommitToRebase() };
      if (history.head.kind !== 'branch') return { error: detachedHead() };
      const name = history.head.name;
      const tracked = wip.trackedChanges();
      if (tracked.length > 0) return { error: localChanges('rebase', tracked) };
      const onto = graph.resolve(base);
      if (onto === null) return { error: this.revisionNotFound(base) };
      const range = mockRange(graph, onto, previous);
      if ('code' in range) return { error: range };
      if (range.merges) {
        return {
          error: invalidHistoryArgument(
            'The commits to rebase include merges: yaggui does not rebuild them. Choose a base after the last merge.',
            'Les commits à rebaser contiennent des merges : yaggui ne les reconstruit pas. Choisis une base après le dernier merge.',
          ),
        };
      }
      const lines = mockTodo(graph, range.ids, todo);
      if ('code' in lines) return { error: lines };
      const total = lines.length;
      const operation = (step: number): RepoOperation => ({
        kind: 'rebase',
        interactive: true,
        step,
        total,
        headName: name,
      });
      const finish = (g: MockGraph): number => {
        const tip = g.headCommit() ?? onto;
        const branch = g.history.local.find((b) => b.name === name);
        if (branch) branch.commit = tip;
        g.history.head = { kind: 'branch', name };
        return tip;
      };
      const ontoLabel = this.sideLabel(graph, this.branchAt(graph, onto), onto);
      /** Halts on the `edit` of line `i`, applied: the rebase stays in progress. */
      const stopOnEdit = (g: MockGraph, i: number): RebaseStop => {
        const line = lines[i];
        const head = g.headCommit();
        const commit = g.history.commits[head ?? -1];
        const stopped = operation(i + 1);
        this.operations.set(repoId, {
          operation: stopped,
          labels: { ours: ontoLabel, theirs: this.sideLabel(g, name, line?.commit ?? null) },
          message: commit ? `${commit.summary}\n\n${commit.body}`.trim() : null,
          conflicts: [],
          complete: (next) => resume(next, i + 1),
          skip: (next) => resume(next, i + 1),
          stopsAgain: 0,
        });
        repo.state = { ...repo.state, operation: stopped };
        return {
          commit: { sha: commit?.sha ?? '', summary: commit?.summary ?? '' },
          step: i + 1,
          total,
        };
      };
      /** Replays the lines from `from` on, like `git rebase --continue`: up to the next
       * `edit`, or to the end. */
      const resume = (g: MockGraph, from: number): HistoryResult => {
        for (let i = from; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          this.applyTodoLine(g, line);
          if (line.command === 'edit') {
            stopOnEdit(g, i);
            return this.historyResult(g, 'commits', previous);
          }
        }
        finish(g);
        return this.historyResult(g, 'commits', previous);
      };
      // While rebasing, HEAD is detached on the commits already replayed.
      history.head = { kind: 'detached', commit: onto };
      const kept = lines.flatMap((line, i) => (line.command === 'drop' ? [] : [i]));
      const conflictAt =
        this.rebaseConflicts.has(repoId) || this.conflictTriggered(repoId, '')
          ? (kept[1] ?? kept[0] ?? 0)
          : null;
      for (const [i, line] of lines.entries()) {
        if (i === conflictAt) {
          this.rebaseConflicts.delete(repoId);
          const commit = history.commits[line.commit];
          return {
            error: this.stopOnConflicts(repoId, {
              operation: operation(i + 1),
              labels: { ours: ontoLabel, theirs: this.sideLabel(graph, name, line.commit) },
              message: line.message ?? commit?.summary ?? null,
              complete: (g, message) => {
                this.applyTodoLine(g, {
                  ...line,
                  message: line.command === 'fixup' ? null : (message ?? line.message),
                });
                return resume(g, i + 1);
              },
              skip: (g) => resume(g, i + 1),
              stopsAgain: 0,
            }),
          };
        }
        this.applyTodoLine(graph, line);
        if (line.command === 'edit') {
          const stopped = stopOnEdit(graph, i);
          return {
            ok: {
              effect:
                stopped.commit.sha === this.commitSha(graph, previous) ? 'upToDate' : 'commits',
              head: stopped.commit.sha,
              previousHead: this.commitSha(graph, previous),
              stopped,
            },
          };
        }
      }
      const tip = finish(graph);
      const same = tip === previous;
      return {
        ok: {
          effect: same ? 'upToDate' : 'commits',
          head: this.commitSha(graph, tip),
          previousHead: this.commitSha(graph, previous),
          stopped: null,
        },
      };
    });
  }

  /** Replays one todo line on HEAD: a copy of the commit, or HEAD amended for a fixup. */
  private applyTodoLine(graph: MockGraph, line: MockTodoLine): void {
    const { commits } = graph.history;
    const original = commits[line.commit];
    const head = graph.headCommit();
    if (line.command === 'drop' || !original || head === null) return;
    const author = (index: number, from: (typeof commits)[number]) => {
      const created = commits[index];
      if (!created) return;
      created.authorName = from.authorName;
      created.authorEmail = from.authorEmail;
      created.authorTime = from.authorTime;
    };
    if (line.command === 'fixup') {
      const target = commits[head];
      if (!target) return;
      const amended = this.newCommit(graph, target.parents, target.summary, target.body);
      author(amended, target);
      const melded = commits[amended];
      if (melded) melded.files = [...new Set([...target.files, ...original.files])];
      this.setHead(graph, amended);
      return;
    }
    // Unchanged pick on its own parent: Git keeps the commit (fast-forward).
    if (line.message === null && original.parents.length === 1 && original.parents[0] === head) {
      this.setHead(graph, line.commit);
      return;
    }
    const [summary = '', ...body] = (line.message ?? `${original.summary}\n${original.body}`).split(
      '\n',
    );
    const copy = this.newCommit(graph, [head], summary, body.join('\n').trim());
    author(copy, original);
    const created = commits[copy];
    if (created) created.files = [...original.files];
    this.setHead(graph, copy);
  }

  private pickWork(
    repoId: number,
    request: CherryPickRequest,
  ): { ok: HistoryResult } | { error: YagguiError } {
    return this.editHistory<HistoryResult>(repoId, (graph) => {
      const guard = this.historyGuard(repoId);
      if (guard) return { error: guard };
      const { commits } = graph.history;
      if (request.commits.length === 0) {
        return {
          error: invalidHistoryArgument(
            'No commit to cherry-pick.',
            'Aucun commit à cherry-picker.',
          ),
        };
      }
      const head = graph.headCommit();
      if (head === null) {
        return {
          error: invalidHistoryArgument(
            'There is no commit to apply them on yet.',
            "Il n'y a pas encore de commit sur lequel les appliquer.",
          ),
        };
      }
      const picked: number[] = [];
      for (const rev of request.commits) {
        const commit = graph.resolve(rev);
        if (commit === null) return { error: this.revisionNotFound(rev) };
        const parents = commits[commit]?.parents.length ?? 0;
        const invalid = checkMainline(commits[commit]?.sha ?? rev, parents, request.mainline, true);
        if (invalid) return { error: invalid };
        if (!picked.includes(commit)) picked.push(commit);
      }
      picked.sort((a, b) => (graph.rowOfCommit(b) ?? 0) - (graph.rowOfCommit(a) ?? 0));
      const first = picked[0] ?? head;
      const names = request.commits.join(' ');
      const blocked = this.overwrittenBy(repoId, graph, picked);
      if (blocked.length > 0) return { error: localChanges('cherry-pick', blocked) };
      if (this.emptyTriggered(repoId, names)) {
        return {
          error: this.stopEmpty(repoId, graph, first, {
            operation: { kind: 'cherryPick' },
            labels: { ours: this.headLabel(graph), theirs: this.sideLabel(graph, null, first) },
            message: commits[first]?.summary ?? null,
            sequence: picked.length > 1,
            complete: (g, message) => {
              this.replay(g, picked.slice(1), message);
              return this.historyResult(g, picked.length > 1 ? 'commits' : 'upToDate', head);
            },
            skip: (g) => {
              this.replay(g, picked.slice(1), null);
              return this.historyResult(g, picked.length > 1 ? 'commits' : 'upToDate', head);
            },
            stopsAgain: 0,
          }),
        };
      }
      if (this.conflictTriggered(repoId, names)) {
        return {
          error: this.stopOnConflicts(repoId, {
            operation: { kind: 'cherryPick' },
            labels: { ours: this.headLabel(graph), theirs: this.sideLabel(graph, null, first) },
            message: commits[first]?.summary ?? null,
            sequence: picked.length > 1,
            complete: (g, message) => {
              this.replay(g, picked, message);
              return this.historyResult(g, 'commits', head);
            },
            skip: (g) => {
              this.replay(g, picked.slice(1), null);
              return this.historyResult(g, picked.length > 1 ? 'commits' : 'upToDate', head);
            },
            stopsAgain: 0,
          }),
        };
      }
      this.replay(graph, picked, null);
      return { ok: this.historyResult(graph, 'commits', head) };
    });
  }

  private revertWork(
    repoId: number,
    request: RevertRequest,
  ): { ok: HistoryResult } | { error: YagguiError } {
    return this.editHistory<HistoryResult>(repoId, (graph) => {
      const guard = this.historyGuard(repoId);
      if (guard) return { error: guard };
      const commit = graph.resolve(request.commit);
      if (commit === null) return { error: this.revisionNotFound(request.commit) };
      const original = graph.history.commits[commit];
      const parents = original?.parents.length ?? 0;
      const invalid = checkMainline(
        original?.sha ?? request.commit,
        parents,
        request.mainline,
        false,
      );
      if (invalid) return { error: invalid };
      const head = graph.headCommit();
      if (head === null) return { error: this.revisionNotFound('HEAD') };
      const blocked = this.overwrittenBy(repoId, graph, [commit]);
      if (blocked.length > 0) return { error: localChanges('revert', blocked) };
      const message = `Revert "${original?.summary ?? ''}"\n\nThis reverts commit ${original?.sha ?? ''}.`;
      const commitRevert = (g: MockGraph, text: string) => {
        const [summary = '', ...body] = text.split('\n');
        const tip = g.headCommit() ?? head;
        this.setHead(g, this.newCommit(g, [tip], summary, body.join('\n').trim()));
        return this.historyResult(g, 'commits', head);
      };
      if (this.emptyTriggered(repoId, `${request.commit} ${original?.summary ?? ''}`)) {
        return {
          error: this.stopEmpty(repoId, graph, commit, {
            operation: { kind: 'revert' },
            labels: { ours: this.headLabel(graph), theirs: this.sideLabel(graph, null, commit) },
            message,
            complete: (g) => this.historyResult(g, 'upToDate', head),
            skip: (g) => this.historyResult(g, 'upToDate', head),
            stopsAgain: 0,
          }),
        };
      }
      if (this.conflictTriggered(repoId, `${request.commit} ${original?.summary ?? ''}`)) {
        return {
          error: this.stopOnConflicts(repoId, {
            operation: { kind: 'revert' },
            labels: { ours: this.headLabel(graph), theirs: this.sideLabel(graph, null, commit) },
            message,
            complete: (g, text) => commitRevert(g, text?.trim() ? text.trim() : message),
            skip: (g) => this.historyResult(g, 'upToDate', head),
            stopsAgain: 0,
          }),
        };
      }
      return { ok: commitRevert(graph, message) };
    });
  }

  private resetPreviewOf(repoId: number, target: string): ResetPreview | YagguiError {
    const graph = this.graph(repoId);
    const wip = this.wip(repoId);
    if (!graph || !wip) return this.notOpen(repoId);
    const commit = graph.resolve(target);
    if (commit === null) return this.revisionNotFound(target);
    const head = graph.headCommit();
    const { history } = graph;
    const lost = new Map<string, LostFile['change']>();
    for (const c of wip.changes('staged')) {
      lost.set(
        c.path,
        c.status === 'added' ? 'added' : c.status === 'deleted' ? 'deleted' : 'modified',
      );
    }
    for (const c of wip.changes('unstaged')) {
      if (c.status === 'untracked' || lost.has(c.path)) continue;
      lost.set(c.path, c.status === 'deleted' ? 'deleted' : 'modified');
    }
    // Like the backend: an untracked file that the target tracks is overwritten.
    const untracked = wip.untracked();
    if (untracked.length > 0) {
      const tracked = new Set<string>();
      for (const index of ancestors(history.commits, commit)) {
        for (const path of history.commits[index]?.files ?? []) tracked.add(path);
      }
      for (const path of untracked) if (tracked.has(path)) lost.set(path, 'untracked');
    }
    return {
      target: history.commits[commit]?.sha ?? '',
      branch: history.head.kind === 'branch' ? history.head.name : null,
      commitsLeftBehind: head === null ? 0 : countExclusive(history, head, commit),
      commitsGained: head === null ? 0 : countExclusive(history, commit, head),
      hardLost: [...lost]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, change]) => ({ path, change })),
    };
  }

  private resetWork(
    repoId: number,
    request: ResetRequest,
  ): { ok: ResetResult } | { error: YagguiError } {
    return this.editHistory<ResetResult>(repoId, (graph) => {
      const wip = this.wip(repoId);
      if (!wip) return { error: this.notOpen(repoId) };
      const preview = this.resetPreviewOf(repoId, request.target);
      if ('code' in preview) return { error: preview };
      const op = this.operation(repoId);
      // Like Git: "Cannot do a soft reset in the middle of a merge".
      if (request.mode === 'soft' && op?.operation.kind === 'merge') {
        return { error: operationInProgress() };
      }
      const commit = graph.resolve(request.target);
      const previous = graph.headCommit();
      if (commit === null || previous === null)
        return { error: this.revisionNotFound(request.target) };
      let backupId: string | null = null;
      if (request.mode === 'hard') {
        if (wip.resetHard().length > 0 || preview.hardLost.length > 0) {
          this.backups++;
          backupId = `mock-reset-${String(this.backups)}`;
        }
      } else if (request.mode === 'mixed') {
        wip.resetIndex();
      }
      this.setHead(graph, commit);
      // Like `git reset`: ends a merge or a single cherry-pick / revert; a rebase, a bisect
      // or a cherry-pick sequence stays in progress.
      const kind = op?.operation.kind;
      if (op && kind !== 'rebase' && kind !== 'bisect' && op.sequence !== true) {
        this.endOperation(repoId);
      }
      return {
        ok: {
          previousHead: this.commitSha(graph, previous),
          head: this.commitSha(graph, commit),
          backupId,
        },
      };
    });
  }

  private continueWork(
    repoId: number,
    message: string | null,
    skip: boolean,
  ): { ok: HistoryResult } | { error: YagguiError } {
    const op = this.operation(repoId);
    const wip = this.wip(repoId);
    if (!wip) return { error: this.notOpen(repoId) };
    if (!op) return { error: noOperation() };
    const { operation } = op;
    if (skip && !op.skip) {
      return {
        error: invalidHistoryArgument(
          'A merge cannot skip a commit: continue or abort it.',
          'Un merge ne peut pas passer de commit : continue-le ou annule-le.',
        ),
      };
    }
    if (!skip && operation.kind === 'bisect') {
      return {
        error: invalidHistoryArgument(
          'A bisect has nothing to continue: mark commits or end it.',
          "Un bisect n'a rien à continuer : marque des commits ou termine-le.",
        ),
      };
    }
    if (skip) {
      for (const c of op.conflicts) if (!c.resolved) wip.resolveConflict(c.path, c.ours);
    } else if (op.conflicts.some((c) => !c.resolved) || wip.hasConflicts()) {
      return { error: unresolvedConflicts() };
    } else if (op.empty && wip.changes('staged').length === 0) {
      return { error: emptyCommit(null) };
    }
    if (op.stopsAgain > 0 && operation.kind === 'rebase') {
      const step = (operation.step ?? 1) + 1;
      const next: RepoOperation = { ...operation, step };
      this.operations.delete(repoId);
      return {
        error: this.stopOnConflicts(repoId, {
          ...op,
          operation: next,
          stopsAgain: op.stopsAgain - 1,
        }),
      };
    }
    return this.editHistory<HistoryResult>(repoId, (graph) => {
      const result = skip && op.skip ? op.skip(graph) : op.complete(graph, message);
      // An interactive rebase halting on its next `edit` replaced the operation: it goes on.
      if (this.operations.get(repoId) === op) this.endOperation(repoId);
      return { ok: result };
    });
  }

  private abortWork(repoId: number): { ok: null } | { error: YagguiError } {
    const op = this.operation(repoId);
    const wip = this.wip(repoId);
    if (!wip) return { error: this.notOpen(repoId) };
    if (!op) return { error: noOperation() };
    return this.editHistory<null>(repoId, (graph) => {
      for (const c of op.conflicts) {
        if (wip.isConflicted(c.path) || c.resolved) wip.resolveConflict(c.path, c.ours);
      }
      for (const path of wip.conflictedPaths()) wip.resolveConflict(path, wip.worktreeText(path));
      // HEAD goes back to where it was: the rebased branch, checked out again.
      const { operation } = op;
      if (operation.kind === 'rebase' && operation.headName) {
        const branch = graph.history.local.find((b) => b.name === operation.headName);
        if (branch) graph.history.head = { kind: 'branch', name: branch.name };
      }
      this.endOperation(repoId);
      return { ok: null };
    });
  }

  private conflictList(repoId: number): ConflictList | YagguiError {
    const graph = this.graph(repoId);
    const wip = this.wip(repoId);
    if (!graph || !wip) return this.notOpen(repoId);
    const op = this.operation(repoId);
    const files: ConflictFile[] = op
      ? op.conflicts.map((c) => ({
          path: c.path,
          kind: c.resolved ? null : c.kind,
          // Like the backend: a resolved file is no longer read from the index stages.
          binary: c.resolved ? false : c.binary,
          resolved: c.resolved,
        }))
      : wip
          .conflictedPaths()
          .map((path) => ({ path, kind: 'content', binary: false, resolved: false }));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      files,
      unresolved: files.filter((f) => !f.resolved).length,
      labels: op?.labels ?? {
        ours: this.headLabel(graph),
        theirs: this.sideLabel(graph, null, null),
      },
    };
  }

  private resolveWork(
    repoId: number,
    paths: string[],
    resolution: ConflictResolution,
  ): { ok: null } | { error: YagguiError } {
    const wip = this.wip(repoId);
    if (!wip) return { error: this.notOpen(repoId) };
    if (paths.length === 0 || (resolution.kind === 'content' && paths.length !== 1)) {
      return {
        error: invalidHistoryArgument(
          resolution.kind === 'content' ? 'Give exactly one file.' : 'No file to resolve.',
          resolution.kind === 'content'
            ? 'Indique exactement un fichier.'
            : 'Aucun fichier à résoudre.',
        ),
      };
    }
    const op = this.operation(repoId);
    const notInConflictPath = paths.find((p) => !wip.isConflicted(p));
    if (notInConflictPath !== undefined) return { error: notInConflict(notInConflictPath) };
    for (const path of paths) {
      const conflict = op?.conflicts.find((c) => c.path === path);
      const text =
        resolution.kind === 'ours'
          ? conflict
            ? conflict.ours
            : wip.worktreeText(path)
          : resolution.kind === 'theirs'
            ? conflict
              ? conflict.theirs
              : '(stashed)\n'
            : resolution.kind === 'content'
              ? resolution.content
              : wip.worktreeText(path);
      wip.resolveConflict(path, text);
      if (conflict) conflict.resolved = true;
    }
    return { ok: null };
  }

  private versionsOf(repoId: number, path: string): ConflictVersions | YagguiError {
    const graph = this.graph(repoId);
    const wip = this.wip(repoId);
    if (!graph || !wip) return this.notOpen(repoId);
    const op = this.operation(repoId);
    const labels = op?.labels ?? {
      ours: this.headLabel(graph),
      theirs: this.sideLabel(graph, null, null),
    };
    const conflict = op?.conflicts.find((c) => c.path === path);
    const merged = wip.worktreeText(path);
    const mergedSide = merged === null ? null : conflictSide(merged, conflict?.binary ?? false);
    // Like the index once resolved: no stages left, only the working tree file.
    if (!wip.isConflicted(path)) {
      return { path, kind: null, base: null, ours: null, theirs: null, merged: mergedSide, labels };
    }
    if (!conflict) {
      return {
        path,
        kind: 'content',
        base: null,
        ours: conflictSide('', false),
        theirs: conflictSide('(stashed)\n', false),
        merged: mergedSide,
        labels,
      };
    }
    return {
      path,
      kind: conflict.kind,
      base: conflictSide(conflict.base, conflict.binary),
      ours: conflictSide(conflict.ours, conflict.binary),
      theirs: conflictSide(conflict.theirs, conflict.binary),
      merged: mergedSide,
      labels,
    };
  }

  readonly commands: YagguiCommands = {
    appInfo: () => Promise.resolve(mockAppInfo),
    launchPath: () => Promise.resolve(null),
    changelog: () => Promise.resolve(structuredClone(mockChangelog)),
    openRepo: (path) => {
      const normalized = path.trim().replace(/(.)[\\/]+$/, '$1');
      if (!normalized || !isAbsolute(normalized)) return fail(invalidPath(path));
      // Paths containing `missing` simulate a folder that does not exist.
      if (/missing/.test(normalized)) {
        return fail(
          mockError(
            'repoNotFound',
            `The folder ${path} does not exist.`,
            `Le dossier ${path} n'existe pas.`,
          ),
        );
      }
      if (/not-a-repo/.test(normalized)) {
        return fail(
          mockError(
            'notARepository',
            `${normalized} is not a Git repository.`,
            `${normalized} n'est pas un dépôt Git.`,
          ),
        );
      }
      // Like `gix::discover`, a folder inside a known worktree opens that repository, unless
      // it is one of its initialized submodules (a repository of its own).
      const isSubmodule = (r: MockRepo) =>
        this.graphs
          .get(r.known.id)
          ?.history.submodules.some(
            (sub) =>
              sub.initialized &&
              (normalized === `${r.known.path}/${sub.path}` ||
                normalized.startsWith(`${r.known.path}/${sub.path}/`)),
          ) ?? false;
      let repo = this.repos.find(
        (r) =>
          normalized === r.known.path ||
          ((normalized.startsWith(`${r.known.path}/`) ||
            normalized.startsWith(`${r.known.path}\\`)) &&
            !isSubmodule(r)),
      );
      if (repo && !repo.known.exists) {
        return fail(
          mockError(
            'repoNotFound',
            `The folder ${normalized} does not exist.`,
            `Le dossier ${normalized} n'existe pas.`,
          ),
        );
      }
      if (!repo) {
        repo = this.newRepo(normalized);
        this.repos.push(repo);
      }
      repo.known.lastOpenedAt = MOCK_NOW;
      this.open.set(repo.known.id, (this.open.get(repo.known.id) ?? 0) + 1);
      this.persist();
      return ok(this.info(repo));
    },
    closeRepo: (repoId) => {
      const refs = (this.open.get(repoId) ?? 0) - 1;
      if (refs > 0) this.open.set(repoId, refs);
      else {
        this.open.delete(repoId);
        // Like `yaggui.db`: the journal outlives the session.
        this.journals.get(repoId)?.restore();
        this.ptys.closeRepo(repoId);
      }
      return ok(null);
    },
    repoState: (repoId) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      return ok(structuredClone(repo.state));
    },
    graphPage: (repoId, start, limit) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const page = graph.page(start, limit);
      if (this.heldWalk === null || page.totalRows <= this.heldWalk) return ok(page);
      return ok({
        ...page,
        totalRows: Math.max(this.heldWalk, start + page.shas.length),
        totalExact: false,
      });
    },
    graphIndexOf: (repoId, rev) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const commit = graph.resolve(rev);
      return commit === null ? fail(this.revisionNotFound(rev)) : ok(graph.locate(commit));
    },
    searchCommits: (repoId, query, fromRow) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      return ok(graph.search(query, fromRow));
    },
    commitDetail: (repoId, sha) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const commit = /^[0-9a-f]{4,40}$/i.test(sha) ? graph.resolve(sha) : null;
      return commit === null ? fail(this.revisionNotFound(sha)) : ok(graph.detail(commit));
    },
    listRefs: (repoId) => {
      const graph = this.graph(repoId);
      const repo = this.find(repoId);
      if (!graph || !repo) return fail(this.notOpen(repoId));
      return ok(structuredClone(graph.refs(repo.state.head, repo.state.upstream)));
    },
    cancelOp: (opId) => {
      const cancel = this.runningOps.get(opId);
      if (!cancel) {
        return fail(
          mockError(
            'opNotFound',
            `Operation #${opId} is not running.`,
            `L'opération n°${opId} n'est pas en cours.`,
          ),
        );
      }
      cancel();
      return ok(null);
    },
    removeStaleIndexLock: (repoId) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      // Same sequence as the real queue: a non-cancellable maintenance operation.
      const opId = this.nextOpId++;
      this.emit('opStarted', { repoId, opId, kind: 'maintenance', cancellable: false });
      const lock = repo.state.indexLock;
      if (lock && !lock.stale) {
        const error: YagguiError = {
          ...mockError(
            'indexLocked',
            'Another Git process is using this repository (index.lock). If no Git process is running, the lock is left over from a crash and can be removed.',
            "Un autre processus Git utilise ce dépôt (index.lock). Si aucun processus Git ne tourne, le verrou provient d'un crash et peut être supprimé.",
          ),
          action: { kind: 'removeIndexLock', repoId, path: lock.path },
        };
        this.emit('opFinished', {
          repoId,
          opId,
          kind: 'maintenance',
          outcome: { kind: 'failed', error },
        });
        return fail(error);
      }
      repo.state = { ...repo.state, indexLock: null };
      this.emit('opFinished', {
        repoId,
        opId,
        kind: 'maintenance',
        outcome: { kind: 'success', note: null },
      });
      setTimeout(() => {
        this.emit('statusChanged', { repoId });
      }, WATCH_DEBOUNCE_MS);
      return ok(null);
    },
    addSafeDirectory: (path) => {
      if (!isAbsolute(path.trim())) return fail(invalidPath(path));
      this.logCommand({
        repoId: null,
        args: ['config', '--global', '--add', 'safe.directory', path],
        cwd: null,
        startedAt: MOCK_NOW,
        durationMs: 12,
        exitCode: 0,
        status: 'success',
        stdout: '',
        stderr: '',
        truncated: false,
      });
      return ok(null);
    },
    listRepos: () =>
      ok(
        this.repos
          .map((repo) => ({ ...repo.known }))
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.id - a.id),
      ),
    setRepoFavorite: (repoId, favorite) => {
      const repo = this.find(repoId);
      if (!repo) {
        return fail(
          mockError(
            'invalidArgument',
            `Unknown repository #${repoId}.`,
            `Dépôt n°${repoId} inconnu.`,
          ),
        );
      }
      repo.known.favorite = favorite;
      this.persist();
      return ok(null);
    },
    forgetRepo: (repoId) => {
      this.repos = this.repos.filter((repo) => repo.known.id !== repoId);
      // `ON DELETE CASCADE`: the repo leaves its workspaces.
      this.workspaces = this.workspaces.map((w) => ({
        ...w,
        repoIds: w.repoIds.filter((id) => id !== repoId),
      }));
      this.open.delete(repoId);
      this.repoUiStates.delete(repoId);
      this.journals.delete(repoId);
      // `ON DELETE SET NULL`: saved tabs of the repo become "new tab" tabs.
      this.tabs = {
        ...this.tabs,
        tabs: this.tabs.tabs.map((tab) => (tab.repoId === repoId ? { ...tab, repoId: null } : tab)),
      };
      this.persist();
      return ok(null);
    },
    getTabs: () => {
      const tabs = structuredClone(this.tabs);
      if (!tabs.tabs.some((tab) => tab.id === tabs.activeTabId)) tabs.activeTabId = null;
      return ok(tabs);
    },
    saveTabs: (tabs) => {
      // Unknown repository ids are stored as NULL, like the foreign key subquery.
      this.tabs = {
        ...structuredClone(tabs),
        tabs: tabs.tabs.map((tab) => ({
          ...tab,
          repoId: tab.repoId !== null && this.find(tab.repoId) ? tab.repoId : null,
        })),
      };
      this.persist();
      return ok(null);
    },
    getRepoUiState: (repoId) => ok(this.repoUiStates.get(repoId) ?? null),
    saveRepoUiState: (repoId, uiState) => {
      if (new TextEncoder().encode(uiState).length > MAX_REPO_UI_STATE) {
        return fail(
          mockError(
            'invalidArgument',
            'The layout of the repository is too large to be saved.',
            'La disposition du dépôt est trop volumineuse pour être enregistrée.',
          ),
        );
      }
      // Like the `SELECT … FROM repos` insert: an unknown repository stores nothing.
      if (this.find(repoId)) {
        this.repoUiStates.set(repoId, uiState);
        this.persist();
      }
      return ok(null);
    },
    getPreferences: () => ok({ ...this.preferences }),
    setPreferences: (preferences) => {
      const terminal = preferences.terminal?.trim() ?? '';
      const normalized = normalizePreferences({ ...preferences, terminal: terminal || null });
      if ('error' in normalized) return fail(normalized.error);
      const gitPath = normalized.ok.gitPath;
      // Like the backend, a path saved earlier is not checked again.
      if (gitPath && gitPath !== this.preferences.gitPath && !isMockGitPathValid(gitPath)) {
        return fail(gitBinaryInvalid(gitPath));
      }
      this.preferences = normalized.ok;
      this.persist();
      return ok({ ...this.preferences });
    },
    exportPreferences: () => {
      this.preferencesFiles.set(
        MOCK_EXPORT_PATH,
        exportPreferencesText(this.preferences, this.settings.overridesSnapshot()),
      );
      return ok(MOCK_EXPORT_PATH);
    },
    previewPreferencesImport: () => {
      const text = this.pickedPreferencesFiles.length
        ? this.pickedPreferencesFiles.shift()
        : sampleImportFile();
      if (text === null || text === undefined) return ok(null);
      this.preferencesFiles.set(MOCK_IMPORT_PATH, text);
      const parsed = parsePreferencesFile(text, this.preferences, normalizePreferences);
      if ('code' in parsed) return fail(parsed);
      return ok(
        previewOf(MOCK_IMPORT_PATH, parsed, this.preferences, this.settings.overridesSnapshot()),
      );
    },
    applyPreferencesImport: (path) => {
      const parsed = parsePreferencesFile(
        this.preferencesFiles.get(path) ?? '',
        this.preferences,
        normalizePreferences,
      );
      if ('code' in parsed) return fail(parsed);
      const failure = this.settings.setKeybindings(parsed.keybindings);
      if ('code' in failure) return fail(failure);
      this.preferences = parsed.preferences;
      this.persist();
      return ok({ preferences: { ...this.preferences }, keybindings: failure });
    },
    migrateLegacyPreferences: (legacy: LegacyPreferences) => {
      if (!this.legacyMigrated) {
        this.legacyMigrated = true;
        this.preferences = {
          ...this.preferences,
          theme: legacy.theme ?? this.preferences.theme,
          locale: legacy.locale ?? this.preferences.locale,
        };
        this.persist();
      }
      return ok({ ...this.preferences });
    },
    getKeybindings: () => ok(this.settings.keybindings()),
    setKeybindings: (overrides) => {
      const result = this.settings.setKeybindings(overrides);
      return 'code' in result ? fail(result) : ok(result);
    },
    gitConfigList: (repoId, scope) => {
      if (repoId !== null && !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const result = this.settings.configList(scope, repoId);
      return 'code' in result ? fail(result) : ok(result);
    },
    gitConfigSet: async (repoId, scope, key, value) => {
      if (repoId !== null && !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const failure = this.settings.configSet(scope, repoId, key, value);
      if (failure) return fail(failure);
      const args = ['config', scope === 'global' ? '--global' : '--local'];
      // The commit box reads the identity from the same configuration.
      if (key === 'user.name' || key === 'user.email') {
        const field = key === 'user.name' ? 'name' : 'email';
        if (scope === 'global') {
          this.globalIdentity = { ...this.identity(repoId ?? 0), [field]: value };
        } else if (repoId !== null) {
          this.identities.set(repoId, { ...this.identity(repoId), [field]: value });
        }
      }
      this.logCommand({
        repoId,
        args:
          value === null
            ? [...args, '--unset-all', '--', key]
            : [...args, '--replace-all', '--', key, value],
        cwd: repoId === null ? null : (this.find(repoId)?.known.path ?? null),
        startedAt: MOCK_NOW,
        durationMs: 8,
        exitCode: 0,
        status: 'success',
        stdout: '',
        stderr: '',
        truncated: false,
      });
      return ok(null);
    },
    checkExternalTool: (kind, name, repoId) => {
      const trimmed = name?.trim() || null;
      if (kind === 'terminal') {
        const configured = trimmed ?? this.preferences.terminal;
        if (!this.terminalAvailable || (configured && /missing/.test(configured))) {
          return fail(terminalNotFound(configured));
        }
        return ok({ tool: configured ?? 'open', ok: true, issue: null });
      }
      const tool =
        trimmed ??
        (kind === 'editor'
          ? this.preferences.editor
          : kind === 'diffTool'
            ? this.preferences.diffTool
            : this.preferences.mergeTool);
      const result = this.settings.check(kind, tool, repoId);
      return 'code' in result ? fail(result) : ok(result);
    },
    openInEditor: (repoId, path) => {
      if (!this.find(repoId) || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const configured = this.preferences.editor;
      if (configured && /missing/.test(configured)) {
        return fail(this.settings.editorNotFound(configured));
      }
      const program = configured ?? 'xdg-open';
      this.settings.openedInEditor.push({ repoId, path, program });
      return ok(program);
    },
    commandLog: () => ok(this.log.map((entry) => ({ ...entry }))),
    clearCommandLog: () => {
      this.log = [];
      return ok(null);
    },
    ptySpawn: (repoId, cols, rows) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      if (!isPtySize(cols) || !isPtySize(rows)) return fail(invalidPtySize(cols, rows));
      const result = this.ptys.spawn(repoId, repo.known.path, cols, rows);
      return 'code' in result ? fail(result) : ok(result);
    },
    ptyWrite: (ptyId, data) => {
      const error = this.ptys.write(ptyId, data);
      return error ? fail(error) : ok(null);
    },
    ptyResize: (ptyId, cols, rows) => {
      if (!isPtySize(cols) || !isPtySize(rows)) return fail(invalidPtySize(cols, rows));
      const error = this.ptys.resize(ptyId, cols, rows);
      return error ? fail(error) : ok(null);
    },
    ptyClose: (ptyId) => {
      this.ptys.close(ptyId);
      return ok(null);
    },
    openTerminal: (repoId) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const configured = this.preferences.terminal;
      // A configured name containing `missing` simulates a terminal that is not installed.
      if (!this.terminalAvailable || (configured && /missing/.test(configured))) {
        return fail({
          ...terminalNotFound(configured),
          detail: `not found in PATH: ${configured ?? 'x-terminal-emulator, gnome-terminal, konsole'}`,
        });
      }
      const program = configured ?? 'open';
      this.openedTerminals.push({ repoId, path: repo.known.path, program });
      return ok(program);
    },
    changedFiles: (repoId, target) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const wip = target.kind === 'commits' ? undefined : (this.wip(repoId) ?? undefined);
      const result = mockChangedFiles(repo.known.name, repo.state.dirty, target, wip);
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    fileDiff: (repoId, target, path, oldPath, options) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const result = mockFileDiff(
        repo.known.name,
        repo.state.dirty,
        target,
        path,
        oldPath,
        options,
        target.kind === 'commits' ? undefined : (this.wip(repoId) ?? undefined),
      );
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    worktreeFile: (repoId, path) => {
      const wip = this.wip(repoId);
      if (!wip) return fail(this.notOpen(repoId));
      const file = wip.editableFile(path);
      if ('error' in file) return fail(file.error);
      const { text, original } = file.ok;
      return ok({ text, original, version: blobId(text) ?? '', lineEnding: lineEndingOf(text) });
    },
    saveWorktreeFile: (repoId, path, content, version) =>
      this.runWrite(
        repoId,
        'editFile',
        [],
        () => {
          const wip = this.wip(repoId);
          if (!wip) return { error: this.notOpen(repoId) };
          const file = wip.editableFile(path);
          if ('error' in file) return file;
          if (blobId(file.ok.text) !== version) {
            return { error: fileChanged(path) };
          }
          wip.saveFile(path, content);
          return { ok: blobId(content) ?? '' };
        },
        { logged: false },
      ),
    fileHistory: (repoId, path, rev, cursor, limit) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const result = mockFileHistory(graph, path, rev, cursor, limit);
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    blame: (repoId, request) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const result = mockBlame(graph, request.path, request.rev, this.wip(repoId));
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    reflog: (repoId, reference, start, limit) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const result = mockReflog(graph, reference, start, limit);
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    // Mock reads answer at once: nothing to cancel.
    cancelRead: () => ok(null),
    stagePaths: (repoId, paths) =>
      this.runWrite(repoId, 'stage', ['add', '-A', '--', ...pathArgs(paths)], () => {
        this.wip(repoId)?.stagePaths(paths);
        return { ok: null };
      }),
    unstagePaths: (repoId, paths) =>
      this.runWrite(repoId, 'stage', ['reset', '-q', 'HEAD', '--', ...pathArgs(paths)], () => {
        this.wip(repoId)?.unstagePaths(paths);
        return { ok: null };
      }),
    stageHunks: (repoId, change) =>
      this.runWrite(repoId, 'stage', ['apply', '--cached', '-'], () =>
        this.hunks(repoId, 'stage', change),
      ),
    unstageHunks: (repoId, change) =>
      this.runWrite(repoId, 'stage', ['apply', '--cached', '--reverse', '-'], () =>
        this.hunks(repoId, 'unstage', change),
      ),
    discardHunks: (repoId, change) =>
      this.runWrite(
        repoId,
        'discard',
        ['apply', '--reverse', '-'],
        () => {
          const result = this.hunks(repoId, 'discard', change);
          if ('error' in result) return result;
          this.backups++;
          return { ok: { backupId: `mock-hunks-${String(this.backups)}` } };
        },
        { journal: () => discardSpec([change.path]) },
      ),
    discardPaths: (repoId, paths, includeStaged) => {
      let touched: string[] = [];
      return this.runWrite(
        repoId,
        'discard',
        includeStaged
          ? ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...pathArgs(paths)]
          : ['restore', '--worktree', '--', ...pathArgs(paths)],
        () => {
          const wip = this.wip(repoId);
          if (!wip) return { error: this.notOpen(repoId) };
          const lists: ('staged' | 'unstaged')[] = includeStaged
            ? ['unstaged', 'staged']
            : ['unstaged'];
          touched =
            paths.kind === 'paths'
              ? paths.paths
              : [...new Set(lists.flatMap((l) => wip.changes(l).map((c) => c.path)))].sort();
          const result = wip.discardPaths(paths, includeStaged);
          return 'error' in result ? result : { ok: { backupId: result.ok } };
        },
        { journal: () => discardSpec(touched) },
      );
    },
    commit: (repoId, request) =>
      this.runWrite<{ sha: string }>(
        repoId,
        'commit',
        [
          'commit',
          ...(request.amend ? ['--amend'] : []),
          ...(request.skipHooks ? ['--no-verify'] : []),
          '-F',
          '-',
        ],
        () => this.commitWork(repoId, request),
        // Hooks take a moment: long enough to see the operation and cancel it.
        {
          cancellable: true,
          delayMs: request.skipHooks ? 120 : 600,
          refs: true,
          journal: ({ sha }) => ({
            op: { kind: request.amend ? 'amend' : 'commit', sha, summary: request.summary.trim() },
          }),
        },
      ).then((result) => {
        if (result.status === 'ok') {
          this.commitStore.addRecentMessage(
            repoId,
            fullMessage(request.summary, request.description),
          );
        }
        return result;
      }),
    lastCommitMessage: (repoId) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const head = graph.headCommit();
      const commit = head === null ? undefined : graph.history.commits[head];
      return ok(commit ? { summary: commit.summary, description: commit.body } : null);
    },
    gitIdentity: (repoId) => {
      if (!this.wip(repoId)) return fail(this.notOpen(repoId));
      return ok(this.identity(repoId));
    },
    setGitIdentity: (repoId, name, email, scope) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      if (!name.trim() || !/^[^\s<>]+@[^\s<>]+$/.test(email.trim())) {
        return fail(
          mockError(
            'invalidArgument',
            'Enter a name and a valid email address.',
            'Saisis un nom et une adresse e-mail valide.',
          ),
        );
      }
      const identity = { name: name.trim(), email: email.trim() };
      if (scope === 'global') this.globalIdentity = identity;
      else this.identities.set(repoId, identity);
      for (const [key, value] of [
        ['user.name', identity.name],
        ['user.email', identity.email],
      ]) {
        this.logCommand({
          repoId,
          args: ['config', ...(scope === 'global' ? ['--global'] : []), key ?? '', value ?? ''],
          cwd: repo.known.path,
          startedAt: MOCK_NOW,
          durationMs: 6,
          exitCode: 0,
          status: 'success',
          stdout: '',
          stderr: '',
          truncated: false,
        });
      }
      return ok(null);
    },
    validateRefName: (repoId, kind, name) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const error = this.refNameError(graph, kind, name);
      return error ? fail(error) : ok(null);
    },
    checkout: (repoId, target, mode) =>
      this.runWrite(
        repoId,
        'checkout',
        target.kind === 'detached'
          ? ['switch', '--detach', target.rev]
          : target.kind === 'branch'
            ? ['switch', target.name]
            : ['switch', '--track', target.name],
        () => this.checkoutWork(repoId, target, mode),
        {
          delayMs: mode === 'stashAndPop' ? 300 : 120,
          refs: true,
          journal: ({ branch }) => ({
            op: { kind: 'checkout', branch, sha: this.headSha(repoId) },
          }),
        },
      ),
    createBranch: (repoId, name, from, checkout) =>
      this.runWrite(
        repoId,
        'branch',
        [checkout ? 'switch' : 'branch', ...(checkout ? ['-c'] : []), name],
        () => this.createBranchWork(repoId, name, from, checkout),
        {
          refs: true,
          // A branch made from a stash also applies it: not journaled, like the backend.
          journal: () => (from.kind === 'stash' ? null : { op: { kind: 'createBranch', name } }),
        },
      ),
    renameBranch: (repoId, name, newName) =>
      this.runWrite(
        repoId,
        'branch',
        ['branch', '-m', name, newName],
        () =>
          this.editHistory<null>(repoId, (graph) => {
            const { history } = graph;
            const branch = history.local.find((b) => b.name === name);
            if (!branch) return { error: this.revisionNotFound(name) };
            const invalid = this.refNameError(graph, 'branch', newName);
            if (invalid) return { error: invalid };
            branch.name = newName;
            if (history.head.kind === 'branch' && history.head.name === name) {
              history.head = { kind: 'branch', name: newName };
            }
            return { ok: null };
          }),
        { refs: true, journal: () => ({ op: { kind: 'renameBranch', from: name, to: newName } }) },
      ),
    deleteBranch: (repoId, request) =>
      this.runWrite(
        repoId,
        'branch',
        ['branch', request.force ? '-D' : '-d', request.name],
        () =>
          this.editHistory<DeleteBranchResult>(repoId, (graph) => {
            const { history } = graph;
            const branch = history.local.find((b) => b.name === request.name);
            if (!branch) return { error: this.revisionNotFound(request.name) };
            if (history.head.kind === 'branch' && history.head.name === request.name) {
              return { error: currentBranch(request.name) };
            }
            const head = graph.headCommit();
            const upstream = history.remote.find((r) => r.name === branch.upstream);
            const mergedInto = upstream?.commit ?? head;
            if (
              !request.force &&
              (mergedInto === null || !ancestors(history.commits, mergedInto).has(branch.commit))
            ) {
              return { error: branchNotMerged(request.name) };
            }
            history.local = history.local.filter((b) => b !== branch);
            const sha = (commit: number) => history.commits[commit]?.sha ?? '';
            let remote = null;
            let remoteError: YagguiError | null = null;
            // An upstream on a remote named `offline` simulates an unreachable remote.
            if (request.deleteRemote && upstream && upstream.name.startsWith('offline/')) {
              remoteError = mockError(
                'gitFailed',
                'The Git command failed.',
                'La commande Git a échoué.',
              );
            } else if (request.deleteRemote && upstream) {
              history.remote = history.remote.filter((r) => r !== upstream);
              remote = { fullName: `refs/remotes/${upstream.name}`, sha: sha(upstream.commit) };
            }
            return {
              ok: {
                local: { fullName: `refs/heads/${branch.name}`, sha: sha(branch.commit) },
                remote,
                remoteError,
              },
            };
          }),
        {
          refs: true,
          delayMs: request.deleteRemote ? 400 : 0,
          cancellable: request.deleteRemote,
          journal: (result) => ({
            op: { kind: 'deleteBranch', name: request.name, remote: result.remote !== null },
            ...(result.remote !== null ? { blocked: { kind: 'published' as const } } : {}),
          }),
        },
      ),
    setUpstream: (repoId, branch, upstream) =>
      this.runWrite(
        repoId,
        'branch',
        ['branch', `--set-upstream-to=${upstream}`, branch],
        () =>
          this.editHistory<null>(repoId, (graph) => {
            const { history } = graph;
            const local = history.local.find((b) => b.name === branch);
            if (!local) return { error: this.revisionNotFound(branch) };
            if (!history.remote.some((r) => r.name === upstream)) {
              return { error: this.revisionNotFound(upstream) };
            }
            local.upstream = upstream;
            return { ok: null };
          }),
        { refs: true },
      ),
    unsetUpstream: (repoId, branch) =>
      this.runWrite(
        repoId,
        'branch',
        ['branch', '--unset-upstream', branch],
        () =>
          this.editHistory<null>(repoId, (graph) => {
            const local = graph.history.local.find((b) => b.name === branch);
            if (!local) return { error: this.revisionNotFound(branch) };
            delete local.upstream;
            return { ok: null };
          }),
        { refs: true },
      ),
    stashPush: (repoId, request) =>
      this.runWrite(
        repoId,
        'stash',
        [
          'stash',
          'push',
          ...(request.includeUntracked ? ['--include-untracked'] : []),
          ...(request.keepIndex ? ['--keep-index'] : []),
          ...(request.message?.trim() ? [`--message=${request.message.trim()}`] : []),
        ],
        () =>
          this.editHistory<StashEntryInfo>(repoId, (graph) => {
            const wip = this.wip(repoId);
            if (!wip) return { error: this.notOpen(repoId) };
            if (wip.hasConflicts()) return { error: unresolvedConflicts() };
            const sha = this.pushStash(
              graph,
              wip,
              request.message,
              request.includeUntracked,
              request.keepIndex,
            );
            const entry = graph.history.stashes[0];
            return sha === null || !entry
              ? { error: nothingToStash() }
              : { ok: { sha, message: entry.message } };
          }),
        { refs: true, delayMs: 120 },
      ),
    stashApply: (repoId, stash) =>
      this.runWrite(
        repoId,
        'stash',
        ['stash', 'apply', `stash@{${String(stash.index)}}`],
        () => {
          const result = this.editHistory<StashEntryInfo>(repoId, (graph) =>
            this.applyStashWork(graph, repoId, stash, false),
          );
          return 'error' in result ? result : { ok: null };
        },
        { refs: true, delayMs: 120 },
      ),
    stashApplyFile: (repoId, request) => {
      const { stash, path, untracked } = request;
      let message = '';
      const spec = (): MockJournalSpec => ({
        op: { kind: 'stashApplyFile', message, path },
        files: true,
      });
      return this.runWrite(
        repoId,
        'stash',
        untracked
          ? ['restore', `--source=stash@{${String(stash.index)}}^3`, '--worktree', '--', path]
          : ['apply', '--3way', '--whitespace=nowarn', '<stash.patch>'],
        () =>
          this.editHistory<null>(repoId, (graph) => {
            const stale = this.findStash(graph, stash);
            if (stale) return { error: stale };
            const wip = this.wip(repoId);
            const entry = graph.history.stashes[stash.index];
            if (!wip || !entry) return { error: this.notOpen(repoId) };
            message = entry.message;
            const result = wip.applyStashFile(
              path,
              untracked,
              this.stashStates.get(entry.sha)?.worktree.get(path)?.text ?? null,
              /conflict/.test(entry.message),
            );
            if ('error' in result) return result;
            return result.ok === 'conflict'
              ? { error: stashFileConflict(path, entry.sha) }
              : { ok: null };
          }),
        {
          refs: true,
          delayMs: 120,
          journal: spec,
          journalError: (error) => (error.code === 'stashConflict' ? spec() : null),
        },
      );
    },
    stashPop: (repoId, stash) =>
      this.runWrite(
        repoId,
        'stash',
        ['stash', 'pop', `stash@{${String(stash.index)}}`],
        () =>
          this.editHistory<StashEntryInfo>(repoId, (graph) =>
            this.applyStashWork(graph, repoId, stash, true),
          ),
        { refs: true, delayMs: 120 },
      ),
    stashDrop: (repoId, stash) =>
      this.runWrite(
        repoId,
        'stash',
        ['stash', 'drop', `stash@{${String(stash.index)}}`],
        () =>
          this.editHistory<StashEntryInfo>(repoId, (graph) => {
            const stale = this.findStash(graph, stash);
            if (stale) return { error: stale };
            const [entry] = graph.history.stashes.splice(stash.index, 1);
            return { ok: { sha: entry?.sha ?? '', message: entry?.message ?? '' } };
          }),
        { refs: true, journal: ({ message }) => ({ op: { kind: 'stashDrop', message } }) },
      ),
    stashRename: (repoId, stash, message) =>
      this.runWrite(
        repoId,
        'stash',
        ['stash', 'store', `--message=${message.trim()}`, stash.sha],
        () =>
          this.editHistory<StashEntryInfo>(repoId, (graph) => {
            const stale = this.findStash(graph, stash);
            if (stale) return { error: stale };
            if (!message.trim()) {
              return {
                error: mockError(
                  'invalidArgument',
                  'The stash message is empty.',
                  'Le message du stash est vide.',
                ),
              };
            }
            const [entry] = graph.history.stashes.splice(stash.index, 1);
            if (!entry) return { error: staleRefs() };
            const renamed = { ...entry, message: message.trim() };
            graph.history.stashes.unshift(renamed);
            return { ok: { sha: renamed.sha, message: renamed.message } };
          }),
        { refs: true },
      ),
    stashBranch: (repoId, stash, name) =>
      this.runWrite(
        repoId,
        'stash',
        ['stash', 'branch', name, `stash@{${String(stash.index)}}`],
        () =>
          this.editHistory<null>(repoId, (graph) =>
            this.stashBranchWork(graph, repoId, stash, name),
          ),
        { refs: true, delayMs: 120 },
      ),
    createTag: (repoId, request) =>
      this.runWrite(
        repoId,
        'tag',
        [
          'tag',
          ...(request.sign ? ['-s'] : request.message?.trim() ? ['-a'] : []),
          ...(request.message?.trim() ? ['-F', '-'] : []),
          request.name,
          request.target,
        ],
        () =>
          this.editHistory<null>(repoId, (graph) => {
            const invalid = this.refNameError(graph, 'tag', request.name);
            if (invalid) return { error: invalid };
            const commit = graph.resolve(request.target);
            if (commit === null) return { error: this.revisionNotFound(request.target) };
            const message = request.message?.trim() ?? '';
            graph.history.tags.push({
              name: request.name,
              commit,
              message: message ? (message.split('\n')[0] ?? '') : null,
            });
            return { ok: null };
          }),
        { refs: true, journal: () => ({ op: { kind: 'createTag', name: request.name } }) },
      ),
    deleteTag: (repoId, name) =>
      this.runWrite(
        repoId,
        'tag',
        ['tag', '-d', name],
        () =>
          this.editHistory<DeletedRef>(repoId, (graph) => {
            const { history } = graph;
            const tag = history.tags.find((t) => t.name === name);
            if (!tag) return { error: this.revisionNotFound(name) };
            history.tags = history.tags.filter((t) => t !== tag);
            return {
              ok: { fullName: `refs/tags/${name}`, sha: history.commits[tag.commit]?.sha ?? '' },
            };
          }),
        { refs: true, journal: () => ({ op: { kind: 'deleteTag', name } }) },
      ),
    merge: (repoId, request) =>
      this.runWrite(
        repoId,
        'merge',
        [
          'merge',
          {
            fastForward: '--ff',
            fastForwardOnly: '--ff-only',
            noFastForward: '--no-ff',
            squash: '--squash',
          }[request.mode],
          '--no-edit',
          request.source,
        ],
        () => this.mergeWork(repoId, request),
        {
          cancellable: true,
          delayMs: 300,
          refs: true,
          journal: ({ effect }) =>
            effect === 'upToDate'
              ? null
              : { op: { kind: 'merge', source: request.source, mode: request.mode } },
        },
      ),
    rebase: (repoId, request) =>
      this.runWrite(
        repoId,
        'rebase',
        ['rebase', request.onto, ...(request.branch ? [request.branch] : [])],
        () => this.rebaseWork(repoId, request),
        {
          cancellable: true,
          delayMs: 600,
          refs: true,
          steps: { phase: 'Rebasing', total: this.rebaseSteps(repoId, request) ?? 0 },
        },
      ),
    cherryPick: (repoId, request) =>
      this.runWrite(
        repoId,
        'cherryPick',
        [
          'cherry-pick',
          ...(request.mainline === null ? [] : ['-m', String(request.mainline)]),
          ...request.commits,
        ],
        () => this.pickWork(repoId, request),
        {
          cancellable: true,
          delayMs: 300,
          refs: true,
          journal: () => ({ op: { kind: 'cherryPick', count: request.commits.length } }),
        },
      ),
    revert: (repoId, request) =>
      this.runWrite(
        repoId,
        'revert',
        [
          'revert',
          '--no-edit',
          ...(request.mainline === null ? [] : ['-m', String(request.mainline)]),
          request.commit,
        ],
        () => this.revertWork(repoId, request),
        {
          cancellable: true,
          delayMs: 300,
          refs: true,
          journal: () => ({ op: { kind: 'revert', sha: request.commit } }),
        },
      ),
    resetPreview: (repoId, target) => {
      const preview = this.resetPreviewOf(repoId, target);
      return 'code' in preview ? fail(preview) : ok(preview);
    },
    reset: (repoId, request) =>
      this.runWrite(
        repoId,
        'reset',
        ['reset', `--${request.mode}`, request.target],
        () => this.resetWork(repoId, request),
        {
          delayMs: 120,
          refs: true,
          journal: () => ({
            op: { kind: 'reset', mode: request.mode, target: request.target },
            files: request.mode !== 'soft',
          }),
        },
      ),
    interactiveRebasePlan: (repoId, base) => {
      const graph = this.graph(repoId);
      if (!graph || !this.wip(repoId)) return fail(this.notOpen(repoId));
      const { head } = graph.history;
      const tip = graph.headCommit();
      if (tip === null) return fail(noCommitToRebase());
      if (head.kind !== 'branch') return fail(detachedHead());
      const commit = graph.resolve(base);
      if (commit === null) return fail(this.revisionNotFound(base));
      const plan = mockPlan(graph, head.name, tip, commit);
      return 'code' in plan ? fail(plan) : ok(plan);
    },
    interactiveRebase: (repoId, base, todo) =>
      this.runWrite(
        repoId,
        'rebase',
        ['rebase', '--interactive', base],
        () => this.interactiveWork(repoId, base, todo),
        {
          cancellable: true,
          delayMs: 600,
          refs: true,
          steps: { phase: 'Rebasing', total: todo.length },
          note: (result) => (result.stopped ? 'paused' : null),
        },
      ),
    rewordCommit: (repoId, sha, message) => {
      const graph = this.graph(repoId);
      if (!graph || !this.wip(repoId)) return fail(this.notOpen(repoId));
      const text = normalizeMockMessage(message);
      if (text === null) {
        return fail(
          invalidHistoryArgument('The commit summary is empty.', 'Le résumé du commit est vide.'),
        );
      }
      const [summary = '', ...rest] = text.split('\n');
      const body = rest.join('\n').trim();
      const target = graph.resolve(sha);
      if (target === null) return fail(this.revisionNotFound(sha));
      const head = graph.headCommit();
      if (target === head) {
        return this.runWrite<{ sha: string }>(
          repoId,
          'commit',
          ['commit', '--amend', '--only', '--allow-empty', '--no-verify', '-F', '-'],
          () => {
            const amended = this.addCommit(repoId, summary.trim(), body, true);
            return amended === null ? { error: this.notOpen(repoId) } : { ok: { sha: amended } };
          },
          {
            delayMs: 120,
            refs: true,
            journal: (result) => ({ op: { kind: 'amend', sha: result.sha, summary } }),
          },
        );
      }
      const { commits } = graph.history;
      if (head === null || !ancestors(commits, head).has(target)) {
        return fail(
          invalidHistoryArgument(
            'This commit is not on the current branch: check out its branch to change its message.',
            "Ce commit n'est pas sur la branche courante : bascule sur sa branche pour modifier son message.",
          ),
        );
      }
      const parent = commits[target]?.parents[0];
      if (parent === undefined) {
        return fail(
          invalidHistoryArgument(
            'The first commit of the repository can only be reworded while it is HEAD.',
            "Le premier commit du dépôt ne peut être reformulé que lorsqu'il est HEAD.",
          ),
        );
      }
      const range = mockRange(graph, parent, head);
      const ids = 'code' in range ? [] : range.ids;
      const position = ids.indexOf(target);
      const todo: RebaseTodoEntry[] = ids.map((id) => ({
        sha: commits[id]?.sha ?? '',
        action: id === target ? 'reword' : 'pick',
        message: id === target ? text : null,
      }));
      const base = this.commitSha(graph, parent);
      return this.runWrite<{ sha: string }>(
        repoId,
        'rebase',
        ['rebase', '--interactive', base],
        () => {
          const result = this.interactiveWork(repoId, base, todo);
          if ('error' in result) return result;
          // The commits after it were replayed one for one: walk back as many parents.
          const after = this.graph(repoId);
          let id = after?.headCommit() ?? null;
          for (let i = position + 1; i < ids.length && id !== null; i++) {
            id = after?.history.commits[id]?.parents[0] ?? null;
          }
          return { ok: { sha: after && id !== null ? this.commitSha(after, id) : '' } };
        },
        { cancellable: true, delayMs: 300, refs: true },
      );
    },
    commitFixup: (repoId, target) => {
      const graph = this.graph(repoId);
      if (!graph || !this.wip(repoId)) return fail(this.notOpen(repoId));
      const commit = graph.resolve(target);
      if (commit === null) return fail(this.revisionNotFound(target));
      const head = graph.headCommit();
      if (head === null || !ancestors(graph.history.commits, head).has(commit)) {
        return fail(
          invalidHistoryArgument(
            'This commit is not on the current branch: check out its branch to create a fixup for it.',
            "Ce commit n'est pas sur la branche courante : bascule sur sa branche pour lui créer un fixup.",
          ),
        );
      }
      const summary = `fixup! ${graph.history.commits[commit]?.summary ?? ''}`;
      const request = { summary, description: '', amend: false, skipHooks: false };
      return this.runWrite<{ sha: string }>(
        repoId,
        'commit',
        ['commit', `--fixup=${this.commitSha(graph, commit)}`],
        () => this.commitWork(repoId, request),
        {
          cancellable: true,
          delayMs: 600,
          refs: true,
          journal: ({ sha }) => ({ op: { kind: 'commit', sha, summary } }),
        },
      );
    },
    autosquashPlan: (repoId, base) => {
      const graph = this.graph(repoId);
      if (!graph || !this.wip(repoId)) return fail(this.notOpen(repoId));
      const { head } = graph.history;
      const tip = graph.headCommit();
      if (tip === null) return fail(noCommitToRebase());
      if (head.kind !== 'branch') return fail(detachedHead());
      let commit: number | null;
      if (base === null) {
        commit = mockAutosquashBase(graph, tip);
        if (commit === null) return ok(null);
      } else {
        commit = graph.resolve(base);
        if (commit === null) return fail(this.revisionNotFound(base));
      }
      const plan = mockPlan(graph, head.name, tip, commit);
      return 'code' in plan ? fail(plan) : ok(mockAutosquashPlan(plan));
    },
    operationDetail: (repoId) => {
      if (!this.wip(repoId)) return fail(this.notOpen(repoId));
      const op = this.operation(repoId);
      if (!op) return ok(null);
      const unresolved = op.conflicts.filter((c) => !c.resolved).length;
      const bisect = op.operation.kind === 'bisect';
      return ok({
        operation: structuredClone(op.operation),
        labels: structuredClone(op.labels),
        message: op.message,
        unresolved,
        canContinue: unresolved === 0 && !bisect,
        canSkip: op.skip !== null,
      });
    },
    continueOperation: (repoId, message) => {
      const op = this.operation(repoId);
      // Like the backend, refused before reaching the queue: no `op-started`.
      if (!this.wip(repoId)) return fail(this.notOpen(repoId));
      if (!op) return fail(noOperation());
      const kind = this.operationKind(op.operation);
      return this.runWrite(
        repoId,
        kind,
        op.operation.kind === 'merge'
          ? ['commit', '-F', '-']
          : [op.operation.kind === 'cherryPick' ? 'cherry-pick' : kind, '--continue'],
        () => this.continueWork(repoId, message, false),
        { cancellable: true, delayMs: 300, refs: true, note: () => this.pausedNote(repoId) },
      );
    },
    skipOperation: (repoId) => {
      const op = this.operation(repoId);
      // Like the backend, refused before reaching the queue: no `op-started`.
      if (!this.wip(repoId)) return fail(this.notOpen(repoId));
      if (!op) return fail(noOperation());
      const kind = this.operationKind(op.operation);
      return this.runWrite(
        repoId,
        kind,
        [op.operation.kind === 'cherryPick' ? 'cherry-pick' : kind, '--skip'],
        () => this.continueWork(repoId, null, true),
        { cancellable: true, delayMs: 300, refs: true, note: () => this.pausedNote(repoId) },
      );
    },
    abortOperation: (repoId) => {
      const op = this.operation(repoId);
      // Like the backend, refused before reaching the queue: no `op-started`.
      if (!this.wip(repoId)) return fail(this.notOpen(repoId));
      if (!op) return fail(noOperation());
      const kind = this.operationKind(op.operation);
      return this.runWrite(
        repoId,
        kind,
        op.operation.kind === 'bisect'
          ? ['bisect', 'reset']
          : [op.operation.kind === 'cherryPick' ? 'cherry-pick' : kind, '--abort'],
        () => this.abortWork(repoId),
        { delayMs: 120, refs: true, note: () => 'aborted' },
      );
    },
    listConflicts: (repoId) => {
      const list = this.conflictList(repoId);
      return 'code' in list ? fail(list) : ok(structuredClone(list));
    },
    resolveConflicts: (repoId, paths, resolution) =>
      this.runWrite(
        repoId,
        'stage',
        resolution.kind === 'ours' || resolution.kind === 'theirs'
          ? ['checkout', `--${resolution.kind}`, '--', ...paths]
          : ['add', '--', ...paths],
        () => this.resolveWork(repoId, paths, resolution),
      ),
    conflictVersions: (repoId, path) => {
      const versions = this.versionsOf(repoId, path);
      return 'code' in versions ? fail(versions) : ok(versions);
    },
    conflictImage: (repoId, path, stage) => {
      const versions = this.versionsOf(repoId, path);
      if ('code' in versions) return fail(versions);
      const present = versions[stage] !== null;
      return ok(present ? mockConflictImage(path, stage) : null);
    },
    mergeTool: (repoId) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      return ok(mockMergeTool(repo.known.path));
    },
    runMergeTool: (repoId, path) => {
      const repoPath = this.find(repoId)?.known.path ?? '';
      const tool = mockMergeTool(repoPath);
      return this.runWrite<{ resolved: boolean }>(
        repoId,
        'mergeTool',
        ['mergetool', '--no-prompt', `--tool=${tool ?? ''}`, '--', path],
        () => {
          if (tool === null) return { error: mergeToolMissing() };
          const wip = this.wip(repoId);
          if (!wip?.isConflicted(path)) return { error: notInConflict(path) };
          // Like the backend (`tests/history.rs`, `merge_tool_*`).
          if (/mergetool-fails/.test(repoPath)) return { error: mergeToolFailed(tool) };
          if (/mergetool-unsaved/.test(repoPath)) return { ok: { resolved: false } };
          // The tool "saves" their version, then Git stages it.
          const done = this.resolveWork(repoId, [path], { kind: 'theirs' });
          return 'error' in done ? done : { ok: { resolved: true } };
        },
        { cancellable: true, delayMs: 1500 },
      );
    },
    gitBinaryInfo: (path) => ok(mockGitBinaryInfo(path)),
    newRepoDefaults: () => ok(this.creator.defaults()),
    cloneRepo: (request) => this.creator.clone(request),
    cancelClone: (cloneId) => {
      this.creator.cancelClone(cloneId);
      return ok(null);
    },
    initRepo: (request) => this.creator.init(request),
    listRemotes: (repoId) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      return ok(this.remoteNames(graph));
    },
    pullDefaultStrategy: (repoId) =>
      this.graph(repoId)
        ? ok<PullStrategy>(this.preferences.pullStrategy ?? 'ffOnly')
        : fail(this.notOpen(repoId)),
    fetch: (repoId, target, prune) =>
      this.runWrite<null>(
        repoId,
        'fetch',
        [
          'fetch',
          '--progress',
          ...(prune ? ['--prune'] : []),
          target.kind === 'all' ? '--all' : target.name,
        ],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          const names = this.remoteNames(graph);
          if (target.kind === 'remote' && !names.includes(target.name)) {
            return { error: remoteNotFound() };
          }
          // A remote named `auth` simulates a refused login, `offline` an unreachable host.
          if (target.kind === 'remote' ? target.name === 'auth' : names.includes('auth')) {
            return { error: authFailed() };
          }
          if (target.kind === 'remote' ? target.name === 'offline' : names.includes('offline')) {
            return { error: hostUnreachable() };
          }
          return { ok: null };
        },
        {
          cancellable: true,
          delayMs: 900,
          progress: true,
          refs: true,
          journal: () =>
            prune
              ? {
                  op: { kind: 'fetch', remote: target.kind === 'remote' ? target.name : null },
                  blocked: { kind: 'pruned' },
                }
              : null,
        },
      ),
    pull: (repoId, requested) => {
      // Like the backend: the preference stands in for "no strategy given".
      const strategy = requested ?? this.preferences.pullStrategy;
      return this.runWrite(
        repoId,
        'pull',
        ['pull', '--progress', ...pullFlags(strategy ?? 'ffOnly')],
        () =>
          this.editHistory<PullResult>(repoId, (graph) => {
            const used = strategy ?? 'ffOnly';
            const { history } = graph;
            const head = history.head;
            if (head.kind !== 'branch') return { error: detachedHead() };
            const branch = history.local.find((b) => b.name === head.name);
            const remote = history.remote.find((r) => r.name === branch?.upstream);
            if (!branch || !remote) return { error: noUpstream(head.name) };
            const behind = countExclusive(history, remote.commit, branch.commit);
            const ahead = countExclusive(history, branch.commit, remote.commit);
            if (behind === 0) return { ok: { strategy: used, upToDate: true } };
            if (ahead > 0 && used === 'ffOnly') return { error: notFastForward() };
            const conflict =
              this.pullConflictRepos.has(repoId) || this.conflictTriggered(repoId, remote.name);
            if (ahead > 0 && used !== 'ffOnly' && conflict) {
              const guard = this.historyGuard(repoId);
              if (guard) return { error: guard };
              this.pullConflictRepos.delete(repoId);
              return { error: this.pullConflicts(repoId, graph, used, branch, remote) };
            }
            if (ahead === 0) branch.commit = remote.commit;
            else {
              // Diverged: the mock records the merge as a commit on top of the remote branch.
              const parent = remote.commit;
              const base = history.commits[branch.commit];
              if (!base) return { error: this.revisionNotFound(head.name) };
              history.commits.push({
                ...structuredClone(base),
                sha: mockSha(0xd1, history.commits.length),
                parents: used === 'merge' ? [branch.commit, parent] : [parent],
                summary:
                  used === 'merge'
                    ? `Merge branch '${remote.name.split('/').slice(1).join('/')}'`
                    : (history.commits[branch.commit]?.summary ?? ''),
              });
              branch.commit = history.commits.length - 1;
            }
            return { ok: { strategy: used, upToDate: false } };
          }),
        {
          cancellable: true,
          delayMs: 900,
          progress: true,
          refs: true,
          journal: ({ upToDate }) =>
            upToDate ? null : { op: { kind: 'pull' }, blocked: { kind: 'pulled' } },
        },
      );
    },
    push: (repoId, request) =>
      this.runWrite(
        repoId,
        'push',
        [
          'push',
          '--progress',
          '--porcelain',
          ...(request.setUpstream ? ['--set-upstream'] : []),
          ...(request.forceWithLease ? ['--force-with-lease'] : []),
          request.remote ?? 'origin',
          request.branch ?? 'HEAD',
        ],
        () =>
          this.editHistory<PushResult>(repoId, (graph) => {
            const { history } = graph;
            const name =
              request.branch ?? (history.head.kind === 'branch' ? history.head.name : null);
            if (name === null) return { error: detachedHead() };
            const branch = history.local.find((b) => b.name === name);
            if (!branch) return { error: this.revisionNotFound(name) };
            let remote = history.remote.find((r) => r.name === branch.upstream);
            let upstreamSet = false;
            if (!remote) {
              if (!request.setUpstream) return { error: noUpstream(name) };
              const remoteName = request.remote ?? this.remoteNames(graph)[0];
              if (!remoteName) return { error: remoteNotFound() };
              remote = { name: `${remoteName}/${name}`, commit: branch.commit };
              history.remote.push(remote);
              branch.upstream = remote.name;
              upstreamSet = true;
            }
            const split = splitRemoteBranch(history, remote.name);
            const remoteName = split?.remote ?? 'origin';
            const remoteBranch = split?.branch ?? name;
            if (remoteName === 'auth') return { error: authFailed() };
            if (remoteName === 'offline') return { error: hostUnreachable() };
            const upToDate = !upstreamSet && remote.commit === branch.commit;
            const behind = countExclusive(history, remote.commit, branch.commit);
            if (request.forceWithLease) {
              if (isProtectedBranch(remoteBranch, this.preferences.protectedBranches))
                return { error: protectedBranch(remoteBranch) };
            } else if (behind > 0) {
              return { error: pushRejected() };
            }
            remote.commit = branch.commit;
            return { ok: { remote: remoteName, remoteBranch, upstreamSet, upToDate } };
          }),
        {
          cancellable: true,
          delayMs: 900,
          progress: true,
          refs: true,
          journal: ({ remote, remoteBranch, upToDate }) =>
            upToDate
              ? null
              : {
                  op: { kind: 'push', remote, name: remoteBranch, delete: false },
                  blocked: { kind: 'published' },
                },
        },
      ),
    forcePushPreview: (repoId, branchName) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const { history } = graph;
      const name = branchName ?? (history.head.kind === 'branch' ? history.head.name : null);
      if (name === null) return fail(detachedHead());
      const branch = history.local.find((b) => b.name === name);
      const remote = history.remote.find((r) => r.name === branch?.upstream);
      if (!branch || !remote) return fail(noUpstream(name));
      const split = splitRemoteBranch(history, remote.name);
      const kept = ancestors(history.commits, branch.commit);
      const dropped = [...ancestors(history.commits, remote.commit)]
        .filter((c) => !kept.has(c))
        .sort((a, b) => b - a);
      const overwritten = dropped.slice(0, 100).map((c) => {
        const commit = history.commits[c];
        return {
          sha: commit?.sha ?? '',
          summary: commit?.summary ?? '',
          author: commit?.authorName ?? '',
        };
      });
      const remoteBranch = split?.branch ?? name;
      return ok<ForcePushPreview>({
        branch: name,
        remote: split?.remote ?? 'origin',
        remoteBranch,
        remoteSha: history.commits[remote.commit]?.sha ?? null,
        overwritten,
        hidden: Math.max(0, dropped.length - 100),
        protected: isProtectedBranch(remoteBranch, this.preferences.protectedBranches),
      });
    },
    pushTag: (repoId, remote, name) =>
      this.runWrite(
        repoId,
        'push',
        ['push', '--progress', '--porcelain', remote, `refs/tags/${name}:refs/tags/${name}`],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          if (!this.remoteNames(graph).includes(remote)) return { error: remoteNotFound() };
          if (remote === 'offline') return { error: hostUnreachable() };
          const tag = graph.history.tags.find((t) => t.name === name);
          if (!tag) return { error: this.revisionNotFound(name) };
          return pushTags(this.remoteTagsOf(repoId), remote, [tag]);
        },
        {
          cancellable: true,
          delayMs: 500,
          progress: true,
          journal: (result) =>
            result.pushed.length > 0
              ? {
                  op: { kind: 'push', remote, name, delete: false },
                  blocked: { kind: 'published' },
                }
              : null,
        },
      ),
    deleteRemoteTag: (repoId, remote, name) =>
      this.runWrite<null>(
        repoId,
        'push',
        ['push', '--progress', '--porcelain', remote, '--delete', `refs/tags/${name}`],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          if (!this.remoteNames(graph).includes(remote)) return { error: remoteNotFound() };
          if (remote === 'offline') return { error: hostUnreachable() };
          this.remoteTagsOf(repoId).get(remote)?.delete(name);
          return { ok: null };
        },
        {
          cancellable: true,
          delayMs: 400,
          progress: true,
          journal: () => ({
            op: { kind: 'push', remote, name, delete: true },
            blocked: { kind: 'published' },
          }),
        },
      ),
    pushAllTags: (repoId, remote) =>
      this.runWrite(
        repoId,
        'push',
        ['push', '--progress', '--porcelain', remote, 'refs/tags/*:refs/tags/*'],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          if (!this.remoteNames(graph).includes(remote)) return { error: remoteNotFound() };
          if (remote === 'offline') return { error: hostUnreachable() };
          return pushTags(this.remoteTagsOf(repoId), remote, graph.history.tags);
        },
        {
          cancellable: true,
          delayMs: 900,
          progress: true,
          journal: (result) =>
            result.pushed.length > 0
              ? {
                  op: { kind: 'pushTags', remote },
                  blocked: { kind: 'published' },
                }
              : null,
        },
      ),
    fetchTags: (repoId, target) =>
      this.runWrite<null>(
        repoId,
        'fetch',
        ['fetch', '--progress', '--tags', target.kind === 'all' ? '--all' : target.name],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          const names = this.remoteNames(graph);
          if (target.kind === 'remote' && !names.includes(target.name)) {
            return { error: remoteNotFound() };
          }
          if (target.kind === 'remote' ? target.name === 'auth' : names.includes('auth')) {
            return { error: authFailed() };
          }
          if (target.kind === 'remote' ? target.name === 'offline' : names.includes('offline')) {
            return { error: hostUnreachable() };
          }
          return { ok: null };
        },
        { cancellable: true, delayMs: 900, progress: true, refs: true },
      ),
    validateRemoteName: (repoId, name) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const refused =
        checkRemoteName(name) ??
        (this.remoteNames(graph).includes(name) ? remoteExists(name) : null);
      return refused ? fail(refused) : ok(null);
    },
    remoteRemovalPreview: (repoId, name) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      if (!this.remoteNames(graph).includes(name)) return fail(remoteNotFound());
      return ok(removalPreview(graph.history, name));
    },
    addRemote: (repoId, name, url, pushUrl) =>
      this.runWrite(
        repoId,
        'remote',
        ['remote', 'add', '--', name, url],
        () =>
          this.editHistory(repoId, (graph) =>
            addRemote(graph.history, this.remoteNames(graph), name, url, pushUrl),
          ),
        { refs: true, journal: () => ({ op: { kind: 'addRemote', name } }) },
      ),
    renameRemote: (repoId, name, newName) =>
      this.runWrite(
        repoId,
        'remote',
        ['remote', 'rename', '--', name, newName],
        () =>
          this.editHistory(repoId, (graph) => {
            const names = this.remoteNames(graph);
            if (!names.includes(name)) return { error: remoteNotFound() };
            const done = renameRemote(graph.history, names, name, newName);
            const tags = this.remoteTagsOf(repoId);
            const held = tags.get(name);
            if ('ok' in done && held) {
              tags.delete(name);
              tags.set(newName, held);
            }
            return done;
          }),
        {
          refs: true,
          journal: () => ({ op: { kind: 'renameRemote', from: name, to: newName } }),
        },
      ),
    setRemoteUrls: (repoId, name, url, pushUrl) => {
      const urls = () => {
        const entry = this.graph(repoId)?.history.remotes.find((r) => r.name === name);
        return entry ? `${entry.url} ${entry.pushUrl ?? ''}` : null;
      };
      const before = urls();
      return this.runWrite(
        repoId,
        'remote',
        ['remote', 'set-url', '--', name, url],
        () =>
          this.editHistory(repoId, (graph) =>
            this.remoteNames(graph).includes(name)
              ? setRemoteUrls(graph.history, name, url, pushUrl)
              : { error: remoteNotFound() },
          ),
        {
          refs: true,
          // Like the backend: journaled (undoable) only when the URLs changed.
          journal: () => (urls() !== before ? { op: { kind: 'setRemoteUrls', name } } : null),
        },
      );
    },
    removeRemote: (repoId, name) =>
      this.runWrite(
        repoId,
        'remote',
        ['remote', 'remove', '--', name],
        () =>
          this.editHistory<RemovedRemote>(repoId, (graph) => {
            if (!this.remoteNames(graph).includes(name)) return { error: remoteNotFound() };
            this.remoteTagsOf(repoId).delete(name);
            return { ok: removeRemote(graph.history, name) };
          }),
        { refs: true, journal: () => ({ op: { kind: 'removeRemote', name } }) },
      ),
    deleteRemoteBranch: (repoId, remote, branch) =>
      this.runWrite(
        repoId,
        'push',
        ['push', '--porcelain', remote, '--delete', `refs/heads/${branch}`],
        () =>
          this.editHistory<DeletedRef | null>(repoId, (graph) => {
            const { history } = graph;
            if (!this.remoteNames(graph).includes(remote)) return { error: remoteNotFound() };
            if (remote === 'offline') return { error: hostUnreachable() };
            const tracking = history.remote.find((r) => r.name === `${remote}/${branch}`);
            if (!tracking) return { ok: null };
            history.remote = history.remote.filter((r) => r !== tracking);
            for (const local of history.local) {
              if (local.upstream === tracking.name) delete local.upstream;
            }
            return {
              ok: {
                fullName: `refs/remotes/${tracking.name}`,
                sha: history.commits[tracking.commit]?.sha ?? '',
              },
            };
          }),
        {
          cancellable: true,
          delayMs: 400,
          refs: true,
          journal: () => ({
            op: { kind: 'push', remote, name: branch, delete: true },
            blocked: { kind: 'published' },
          }),
        },
      ),
    undo: (repoId) =>
      this.runWrite(
        repoId,
        'undo',
        ['update-ref', '--stdin'],
        () => this.undoWork(repoId, 'undo'),
        {
          delayMs: 120,
          refs: true,
        },
      ),
    redo: (repoId) =>
      this.runWrite(
        repoId,
        'redo',
        ['update-ref', '--stdin'],
        () => this.undoWork(repoId, 'redo'),
        {
          delayMs: 120,
          refs: true,
        },
      ),
    undoState: (repoId) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const log = this.journals.get(repoId);
      const current = mockRefs(graph.history);
      return ok({
        undo: log?.step(log.undoTarget(), current) ?? null,
        redo: log?.step(log.redoTarget(), current) ?? null,
      });
    },
    opHistory: (repoId) => {
      if (!this.graph(repoId)) return fail(this.notOpen(repoId));
      return ok(this.journals.get(repoId)?.history() ?? []);
    },
    listWorkspaces: () => ok(structuredClone(sortWorkspaces(this.workspaces))),
    createWorkspace: (name, repoIds) => {
      const checked = checkWorkspaceName(name, this.workspaces, null);
      if ('error' in checked) return fail(checked.error);
      const workspace: Workspace = {
        id: Math.max(0, ...this.workspaces.map((w) => w.id)) + 1,
        name: checked.ok,
        repoIds: [],
      };
      this.workspaces.push(workspace);
      this.addMembers(workspace, repoIds);
      this.persist();
      return ok(structuredClone(workspace));
    },
    renameWorkspace: (workspaceId, name) => {
      const workspace = this.workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return fail(unknownWorkspace(workspaceId));
      const checked = checkWorkspaceName(name, this.workspaces, workspaceId);
      if ('error' in checked) return fail(checked.error);
      workspace.name = checked.ok;
      this.persist();
      return ok(structuredClone(workspace));
    },
    deleteWorkspace: (workspaceId) => {
      this.workspaces = this.workspaces.filter((w) => w.id !== workspaceId);
      this.persist();
      return ok(null);
    },
    addToWorkspace: (workspaceId, repoIds) => {
      const workspace = this.workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return fail(unknownWorkspace(workspaceId));
      this.addMembers(workspace, repoIds);
      this.persist();
      return ok(structuredClone(workspace));
    },
    removeFromWorkspace: (workspaceId, repoId) => {
      const workspace = this.workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return fail(unknownWorkspace(workspaceId));
      workspace.repoIds = workspace.repoIds.filter((id) => id !== repoId);
      this.persist();
      return ok(structuredClone(workspace));
    },
    repoOverview: (repoId) => {
      const repo = this.find(repoId);
      if (!repo) return fail(this.unknownRepo(repoId));
      if (!repo.known.exists) return ok({ kind: 'missing' });
      const wip = this.wips.get(repoId);
      const state = structuredClone(repo.state);
      if (wip) state.dirty = wip.dirty();
      return ok({ kind: 'ready', state, lastFetchedAt: this.lastFetch.get(repoId) ?? null });
    },
    fetchKnownRepo: async (repoId, prune) => {
      const repo = this.find(repoId);
      if (!repo) return { status: 'error', error: this.unknownRepo(repoId) };
      if (!repo.known.exists) {
        return {
          status: 'error',
          error: mockError(
            'repoNotFound',
            `The folder ${repo.known.path} does not exist.`,
            `Le dossier ${repo.known.path} n'existe pas.`,
          ),
        };
      }
      // Like `fetch_known`: joins the open session, or opens one for the time of the fetch.
      this.open.set(repoId, (this.open.get(repoId) ?? 0) + 1);
      try {
        const result = await this.commands.fetch(repoId, { kind: 'all' }, prune);
        if (result.status === 'ok') this.lastFetch.set(repoId, MOCK_NOW);
        return result;
      } finally {
        await this.commands.closeRepo(repoId);
      }
    },
    scanFolder: (request) => this.scanner.scan(request),
    cancelScan: (scanId) => {
      this.scanner.cancel(scanId);
      return ok(null);
    },
    importRepos: (paths, workspaceId) => {
      const workspace =
        workspaceId === null ? null : this.workspaces.find((w) => w.id === workspaceId);
      if (workspace === undefined) return fail(unknownWorkspace(workspaceId ?? 0));
      const repoIds: number[] = [];
      const failed: { path: string; error: YagguiError }[] = [];
      for (const path of paths) {
        const located = this.locate(path);
        if ('error' in located) {
          failed.push({ path, error: located.error });
          continue;
        }
        let repo = this.repos.find((r) => r.known.path === located.path);
        if (!repo) {
          repo = this.newRepo(located.path);
          repo.known.lastOpenedAt = 0;
          this.repos.push(repo);
        }
        if (!repoIds.includes(repo.known.id)) repoIds.push(repo.known.id);
      }
      if (workspace) this.addMembers(workspace, repoIds);
      this.persist();
      return ok({ repoIds, failed });
    },
    submoduleStatus: (repoId) => {
      const graph = this.graph(repoId);
      const repo = this.find(repoId);
      if (!graph || !repo) return fail(this.notOpen(repoId));
      return ok(this.modules.submoduleStatus(repoId, repo.known.path, graph.history));
    },
    updateSubmodules: (repoId, request) =>
      this.runWrite(
        repoId,
        'submodule',
        [
          'submodule',
          'update',
          '--progress',
          ...(request.init ? ['--init'] : []),
          ...(request.recursive ? ['--recursive'] : []),
          '--',
          ...request.paths,
        ],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          return this.modules.updateSubmodules(repoId, graph.history, request);
        },
        {
          cancellable: true,
          delayMs: 900,
          progress: true,
          journal: () => ({
            op: { kind: 'updateSubmodules', count: request.paths.length },
            blocked: { kind: 'downloaded' },
          }),
        },
      ),
    createWorktree: (repoId, request) =>
      this.runWrite(
        repoId,
        'worktree',
        [
          'worktree',
          'add',
          ...(request.branch.kind === 'new' ? ['-b', request.branch.name] : []),
          '--',
          request.path,
          request.branch.kind === 'new' ? request.branch.start : request.branch.name,
        ],
        () =>
          this.editHistory(repoId, (graph) =>
            this.modules.createWorktree(graph.history, request, isAbsolute),
          ),
        {
          cancellable: true,
          delayMs: 300,
          refs: true,
          journal: (path) => ({
            op: { kind: 'createWorktree', path, branch: request.branch.name },
          }),
        },
      ),
    worktreeRemovePreview: (repoId, path) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const result = this.modules.removePreview(graph.history, path);
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    removeWorktree: (repoId, path, force) => {
      const branch = this.graph(repoId)?.history.worktrees.find((w) => w.path === path)?.head;
      const lost = this.modules.isWorktreeDirty(path);
      return this.runWrite(
        repoId,
        'worktree',
        ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          return this.modules.removeWorktree(graph.history, path, force);
        },
        {
          delayMs: 200,
          refs: true,
          journal: () => ({
            op: {
              kind: 'removeWorktree',
              path,
              branch: branch && branch.kind !== 'detached' ? branch.name : null,
            },
            ...(lost ? { blocked: { kind: 'filesDeleted' } as const } : {}),
          }),
        },
      );
    },
    pruneWorktrees: (repoId) =>
      this.runWrite(
        repoId,
        'worktree',
        ['worktree', 'prune'],
        () => {
          const graph = this.graph(repoId);
          if (!graph) return { error: this.notOpen(repoId) };
          return this.modules.pruneWorktrees(graph.history);
        },
        { refs: true },
      ),
    lfsStatus: (repoId) =>
      this.graph(repoId) ? ok(this.modules.lfsStatus(repoId)) : fail(this.notOpen(repoId)),
    lfsPull: (repoId) =>
      this.runWrite(repoId, 'lfs', ['lfs', 'pull'], () => this.modules.lfsPull(), {
        cancellable: true,
        delayMs: 900,
        progress: true,
        journal: () => ({ op: { kind: 'lfsPull' }, blocked: { kind: 'downloaded' } }),
      }),
    lfsTrack: (repoId, pattern) =>
      this.runWrite(
        repoId,
        'lfs',
        ['lfs', 'track', '--', pattern],
        () => this.modules.lfsTrack(repoId, pattern),
        { journal: () => ({ op: { kind: 'lfsTrack', pattern: pattern.trim() } }) },
      ),
    relocateRepo: (repoId, path) => {
      const repo = this.find(repoId);
      if (!repo) return fail(this.unknownRepo(repoId));
      const located = this.locate(path);
      if ('error' in located) return fail(located.error);
      this.open.delete(repoId);
      const other = this.repos.find((r) => r.known.path === located.path);
      if (other && other !== repo) {
        // Merged into the entry already known at that path.
        other.known.favorite ||= repo.known.favorite;
        other.known.lastOpenedAt = Math.max(other.known.lastOpenedAt, repo.known.lastOpenedAt);
        this.workspaces = this.workspaces.map((w) => ({
          ...w,
          repoIds: w.repoIds.includes(other.known.id)
            ? w.repoIds.filter((id) => id !== repoId)
            : w.repoIds.map((id) => (id === repoId ? other.known.id : id)),
        }));
        this.repos = this.repos.filter((r) => r !== repo);
        this.tabs = {
          ...this.tabs,
          tabs: this.tabs.tabs.map((tab) =>
            tab.repoId === repoId ? { ...tab, repoId: null } : tab,
          ),
        };
        this.persist();
        return ok({ ...other.known });
      }
      repo.known = {
        ...repo.known,
        path: located.path,
        name: folderName(located.path),
        exists: true,
      };
      this.persist();
      return ok({ ...repo.known });
    },
    commitSettings: (repoId) => {
      const repo = this.find(repoId);
      if (!repo || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      return ok(mockCommitSettings(repo.known.name));
    },
    verifyCommitSignature: (repoId, sha) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
        return fail(
          mockError(
            'invalidArgument',
            `"${sha}" is not a commit id.`,
            `« ${sha} » n'est pas un identifiant de commit.`,
          ),
        );
      }
      const commit = graph.resolve(sha);
      if (commit === null) return fail(this.revisionNotFound(sha));
      return ok(mockSignatureCheck(graph.detail(commit).signature));
    },
    recentCommitMessages: (repoId) => ok(this.commitStore.recentMessages(repoId)),
    listCommitTemplates: () => ok(this.commitStore.commitTemplates()),
    saveCommitTemplate: (template) => {
      const result = this.commitStore.saveCommitTemplate(template);
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    deleteCommitTemplate: (id) => {
      this.commitStore.deleteCommitTemplate(id);
      return ok(null);
    },
    listIdentityProfiles: () => ok(this.commitStore.identityProfiles()),
    saveIdentityProfile: (profile) => {
      const result = this.commitStore.saveIdentityProfile(profile);
      return 'error' in result ? fail(result.error) : ok(result.ok);
    },
    deleteIdentityProfile: (id) => {
      this.commitStore.deleteIdentityProfile(id);
      return ok(null);
    },
    gitignorePreview: (repoId, path, kind) => {
      const wip = this.wip(repoId);
      if (!wip) return fail(this.notOpen(repoId));
      const rule = mockIgnoreRule(path, kind);
      if ('error' in rule) return fail(rule.error);
      const current = wip.worktreeFile('.gitignore') ?? '';
      const matches = wip.untracked().filter((p) => rule.ok.matches(p));
      return ok({
        rule: rule.ok.line,
        exists: current.split('\n').some((l) => l.replace(/\r$/, '') === rule.ok.line),
        matches: matches.slice(0, GITIGNORE_PREVIEW_MAX),
        matchCount: matches.length,
      });
    },
    addToGitignore: (repoId, path, kind) => {
      let added = false;
      return this.runWrite<string>(
        repoId,
        'maintenance',
        ['# append to .gitignore'],
        () => {
          const wip = this.wip(repoId);
          if (!wip) return { error: this.notOpen(repoId) };
          const rule = mockIgnoreRule(path, kind);
          if ('error' in rule) return rule;
          const current = wip.worktreeFile('.gitignore') ?? '';
          if (current.split('\n').some((l) => l.replace(/\r$/, '') === rule.ok.line)) {
            return { ok: rule.ok.line };
          }
          wip.ignore(wip.untracked().filter((p) => p !== '.gitignore' && rule.ok.matches(p)));
          wip.writeFile('.gitignore', appendRule(current, rule.ok.line));
          added = true;
          return { ok: rule.ok.line };
        },
        {
          journal: (rule) => (added ? { op: { kind: 'gitignore', rule }, files: true } : null),
        },
      );
    },
    stashPushPaths: (repoId, request) =>
      this.runWrite<StashEntryInfo>(
        repoId,
        'stash',
        [
          'stash',
          'push',
          ...(request.includeUntracked ? ['--include-untracked'] : []),
          ...(request.message?.trim() ? [`--message=${request.message.trim()}`] : []),
          '--',
          ...request.paths,
        ],
        () =>
          this.editHistory<StashEntryInfo>(repoId, (graph) => {
            const wip = this.wip(repoId);
            if (!wip) return { error: this.notOpen(repoId) };
            if (wip.hasConflicts()) return { error: unresolvedConflicts() };
            const saved = wip.stashPaths(request.paths, request.includeUntracked);
            if (!saved) return { error: nothingToStash() };
            const { history } = graph;
            const base = graph.headCommit() ?? 0;
            const sha = mockSha(0x57a5, 1000 + this.nextOpId++);
            const where = history.head.kind === 'branch' ? history.head.name : '(no branch)';
            const message = request.message?.trim()
              ? `On ${where}: ${request.message.trim()}`
              : `WIP on ${where}: ${(history.commits[base]?.sha ?? '').slice(0, 7)} ${history.commits[base]?.summary ?? ''}`;
            history.stashes.unshift({ sha, base, untrackedSha: null, message });
            this.stashStates.set(sha, saved);
            return { ok: { sha, message } };
          }),
        {
          refs: true,
          delayMs: 120,
          journal: ({ message }) => {
            const paths = [...request.paths].sort();
            return {
              op: {
                kind: 'stashPush',
                message,
                paths: paths.slice(0, JOURNAL_PATHS_MAX),
                count: paths.length,
              },
              files: true,
            };
          },
        },
      ),
    graphFilter: (repoId) => {
      if (!this.find(repoId) || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      return ok(structuredClone(this.graphFilters.get(repoId) ?? EMPTY_GRAPH_FILTER));
    },
    setGraphFilter: (repoId, filter) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const normalized = normalizeFilter(filter);
      if ('error' in normalized) return fail(normalized.error);
      if (isFilterEmpty(normalized.ok)) this.graphFilters.delete(repoId);
      else this.graphFilters.set(repoId, normalized.ok);
      this.persist();
      this.graphs.set(repoId, this.makeGraph(repoId, graph.history));
      return ok(structuredClone(normalized.ok));
    },
    mergeBase: (repoId, a, b) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const [ca, cb] = [graph.resolve(a), graph.resolve(b)];
      if (ca === null) return fail(this.revisionNotFound(a));
      if (cb === null) return fail(this.revisionNotFound(b));
      return ok(mergeBase(graph, ca, cb));
    },
    compareRevisions: (repoId, a, b) => {
      const graph = this.graph(repoId);
      if (!graph) return fail(this.notOpen(repoId));
      const [ca, cb] = [graph.resolve(a), graph.resolve(b)];
      if (ca === null) return fail(this.revisionNotFound(a));
      if (cb === null) return fail(this.revisionNotFound(b));
      return ok(compare(graph, ca, cb));
    },
    diffImage: (repoId, target, path, oldPath, side) => {
      if (!this.find(repoId) || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const shown = side === 'old' ? (oldPath ?? path) : path;
      if (!shown.trim() || shown.startsWith('/') || shown.split('/').includes('..')) {
        return fail(
          mockError(
            'invalidArgument',
            `Expected a path relative to the repository, got "${shown}".`,
            `Chemin relatif au dépôt attendu, reçu « ${shown} ».`,
          ),
        );
      }
      const diff = mockFileDiff(
        this.find(repoId)?.known.name ?? '',
        this.find(repoId)?.state.dirty ?? { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        target,
        path,
        oldPath,
        { ignoreWhitespace: false, contextLines: 3, fullFile: false, force: false },
        target.kind === 'commits' ? undefined : (this.wip(repoId) ?? undefined),
      );
      // Absent side (added / deleted file): no image, as the backend.
      if ('ok' in diff && (side === 'old' ? diff.ok.oldMode : diff.ok.newMode) === null) {
        return ok(null);
      }
      return ok(mockDiffImage(shown, side));
    },
    runDiffTool: async (repoId, target, path, oldPath) => {
      if (!this.find(repoId) || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      const tool = this.preferences.diffTool;
      const args = [
        'difftool',
        '--no-prompt',
        `--tool=${tool ?? ''}`,
        ...(target.kind === 'staged'
          ? ['--cached']
          : target.kind === 'commits'
            ? [target.from ?? `${target.to}^`, target.to]
            : []),
        '--',
        path,
        ...(oldPath && oldPath !== path ? [oldPath] : []),
      ];
      if (tool === null) return fail(diffToolMissing());
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A tool name containing `missing` simulates a tool that is not installed.
      if (/missing/.test(tool)) {
        this.logCommand({
          repoId,
          args,
          cwd: this.find(repoId)?.known.path ?? null,
          startedAt: MOCK_NOW,
          durationMs: 300,
          exitCode: 1,
          status: 'failed',
          stdout: '',
          stderr: `fatal: unknown difftool ${tool}\n`,
          truncated: false,
        });
        return fail(diffToolFailed(tool));
      }
      this.logCommand({
        repoId,
        args,
        cwd: this.find(repoId)?.known.path ?? null,
        startedAt: MOCK_NOW,
        durationMs: 300,
        exitCode: 0,
        status: 'success',
        stdout: '',
        stderr: '',
        truncated: false,
      });
      this.externalDiffs.push({ repoId, path, tool });
      return ok(tool);
    },
    revealPath: (repoId, path) => {
      if (!this.find(repoId) || !this.open.has(repoId)) return fail(this.notOpen(repoId));
      this.revealed.push({ repoId, path });
      return ok(null);
    },
    branchCleanup: (repoId) => {
      const graph = this.graph(repoId);
      const repo = this.find(repoId);
      if (!graph || !repo) return fail(this.notOpen(repoId));
      const refs = graph.refs(repo.state.head, repo.state.upstream);
      return ok(branchCleanup(graph, refs, this.preferences.protectedBranches));
    },
    deleteBranches: (repoId, names) =>
      this.runWrite<DeleteBranchesResult>(
        repoId,
        'branch',
        ['branch', '-D', '--', ...names],
        () =>
          this.editHistory<DeleteBranchesResult>(repoId, (graph, repo) =>
            deleteBranches(
              graph,
              graph.refs(repo.state.head, repo.state.upstream),
              names,
              this.preferences.protectedBranches,
            ),
          ),
        {
          refs: true,
          delayMs: 150,
          journal: (result) => ({
            op: {
              kind: 'deleteBranches',
              names: result.deleted
                .map((d) => d.fullName.slice('refs/heads/'.length))
                .slice(0, JOURNAL_PATHS_MAX),
              count: result.deleted.length,
            },
          }),
        },
      ),
    avatar: (hash) => {
      if (!/^[0-9a-f]{64}$/.test(hash)) return fail(invalidAvatarHash());
      this.avatarRequests.push(hash);
      this.avatarCache.add(hash);
      return ok(mockAvatar(hash));
    },
    clearAvatarCache: () => {
      const removed = this.avatarCache.size;
      this.avatarCache.clear();
      return ok(removed);
    },
    checkForUpdate: () => {
      this.updateChecks += 1;
      const failure = this.updateFailure;
      this.updateFailure = null;
      return failure ? fail(failure) : ok(this.availableUpdate);
    },
    installUpdate: () => {
      const failure = this.updateFailure;
      this.updateFailure = null;
      if (failure) return fail(failure);
      // The real backend restarts the app once installed; the mock stops halfway, so the
      // progress stays on screen.
      this.updateInstalls += 1;
      this.emit('updateProgress', { percent: 42 });
      return ok(null);
    },
    openReleasePage: () => {
      this.releasePageOpens += 1;
      return ok(null);
    },
    updateInTerminal: (cols, rows) => {
      const failure = this.updateFailure;
      this.updateFailure = null;
      if (failure) return fail(failure);
      if (!isPtySize(cols) || !isPtySize(rows)) return fail(invalidPtySize(cols, rows));
      const update = this.availableUpdate;
      const upgrade = update && mockUpgrade(update);
      if (!upgrade) {
        return fail({
          code: 'updateInstallFailed',
          message: {
            en: 'The update could not be installed.',
            fr: "La mise à jour n'a pas pu être installée.",
          },
          action: { kind: 'retry' },
          detail: 'this copy is not upgraded by a package manager',
          payload: null,
        });
      }
      // The real backend downloads the `.deb` / `.rpm` first; the AUR helper builds its own.
      if (update.channel !== 'aur') this.emit('updateProgress', { percent: 100 });
      const info = this.ptys.spawnUpgrade(upgrade.program, upgrade.args, cols, rows, {
        lines: upgrade.lines,
        exitCode: this.upgradeExitCode,
      });
      return ok(info);
    },
    restartApp: () => {
      this.restarts += 1;
      return Promise.resolve();
    },
    pickRepoFolder: (title) => {
      if (this.pickedFolders.length > 0) return ok(this.pickedFolders.shift() ?? null);
      // No native picker in a browser: a prompt stands in for it (Playwright dismisses it).
      const answer = window.prompt(title);
      return ok(answer?.trim() ? answer.trim() : null);
    },
  };
}

function invalidAvatarHash(): YagguiError {
  return mockError('invalidArgument', 'Invalid avatar hash.', "Hash d'avatar invalide.");
}

/**
 * Like Gravatar with `d=404`: only some addresses have a picture (two thirds here). Here a flat disc
 * whose hue comes from the hash, as an SVG `data:` URL (the CSP allows `data:` in `img-src`).
 */
function mockAvatar(hash: string): string | null {
  const seed = parseInt(hash.slice(0, 4), 16);
  if (seed % 3 === 0) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${String(seed % 360)} 45% 45%)"/><circle cx="20" cy="15" r="7" fill="#fff" opacity=".85"/><ellipse cx="20" cy="38" rx="14" ry="12" fill="#fff" opacity=".85"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** `list` with the ref `name` as in `target` (removed when `target` lacks it), in place. */
function replaceRef<R extends { name: string }>(list: R[], target: R[], name: string): R[] {
  const wanted = target.find((r) => r.name === name);
  const copy = wanted ? structuredClone(wanted) : null;
  const index = list.findIndex((r) => r.name === name);
  if (index < 0) return copy ? [...list, copy] : list;
  return copy ? list.map((r, i) => (i === index ? copy : r)) : list.filter((_, i) => i !== index);
}

function discardSpec(paths: string[]): MockJournalSpec {
  return {
    op: { kind: 'discard', paths: paths.slice(0, JOURNAL_PATHS_MAX), count: paths.length },
    files: true,
  };
}

function pullFlags(strategy: PullStrategy): string[] {
  if (strategy === 'rebase') return ['--rebase'];
  return strategy === 'merge' ? ['--no-rebase', '--ff'] : ['--no-rebase', '--ff-only'];
}

/** Interactive rebase on an unborn branch (`interactive.rs`). */
function noCommitToRebase(): YagguiError {
  return invalidHistoryArgument(
    'There is no commit to rebase yet.',
    "Il n'y a pas encore de commit à rebaser.",
  );
}

function detachedHead(): YagguiError {
  return mockError(
    'detachedHead',
    'HEAD is detached (no current branch): check out a branch first.',
    "HEAD est détaché (aucune branche courante) : fais d'abord un checkout d'une branche.",
  );
}

export const mockBackend = new MockBackend();

/** In-browser backend used by `pnpm dev` and `pnpm test:ui` (no Tauri). */
export const mockClient: YagguiClient = {
  commands: mockBackend.commands,
  events: mockBackend.events,
};
