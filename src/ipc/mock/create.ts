import type {
  CloneProgress,
  CloneRequest,
  CloneResult,
  GitBinaryInfo,
  YagguiError,
  InitRequest,
  InitResult,
  NewRepoDefaults,
  Preferences,
} from '../bindings';
import {
  AUTO_FETCH_MAX_MINUTES,
  AUTO_FETCH_MIN_MINUTES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
} from '../bindings';
import type { IpcResult } from '../result';
import { DEFAULT_AI_PREFERENCES } from '../aiDefaults';
import { normalizeAi } from './ai';
import { authFailed, hostUnreachable, remoteNotFound } from './network';
import { invalidRefName, isValidRefName } from './refs';
import { isToolName } from './settings';

function error(
  code: YagguiError['code'],
  en: string,
  fr: string,
  detail?: string,
  action: YagguiError['action'] = null,
): YagguiError {
  return { code, message: { en, fr }, action, detail: detail ?? null, payload: null };
}

function invalid(en: string, fr: string): YagguiError {
  return error('invalidArgument', en, fr);
}

/** `MAX_PROTECTED_BRANCHES` in `store/types.rs`. */
const MAX_PROTECTED_BRANCHES = 100;

/** Same checks as `Preferences::normalized` in Rust. */
export function normalizePreferences(
  prefs: Preferences,
): { ok: Preferences } | { error: YagguiError } {
  if (prefs.fontSize < FONT_SIZE_MIN || prefs.fontSize > FONT_SIZE_MAX) {
    return {
      error: invalid(
        `Font size must be between ${String(FONT_SIZE_MIN)} and ${String(FONT_SIZE_MAX)}.`,
        `Taille de police : une valeur entre ${String(FONT_SIZE_MIN)} et ${String(FONT_SIZE_MAX)} est attendue.`,
      ),
    };
  }
  if (
    prefs.autoFetchMinutes < AUTO_FETCH_MIN_MINUTES ||
    prefs.autoFetchMinutes > AUTO_FETCH_MAX_MINUTES
  ) {
    return {
      error: invalid(
        `Auto-fetch interval (minutes) must be between ${String(AUTO_FETCH_MIN_MINUTES)} and ${String(AUTO_FETCH_MAX_MINUTES)}.`,
        `Intervalle d'auto-fetch (minutes) : une valeur entre ${String(AUTO_FETCH_MIN_MINUTES)} et ${String(AUTO_FETCH_MAX_MINUTES)} est attendue.`,
      ),
    };
  }
  const fonts: (string | null)[] = [];
  for (const font of [prefs.uiFont, prefs.codeFont]) {
    const trimmed = font?.trim() ?? '';
    if (/[;{}<>\\"'\p{Cc}]/u.test(trimmed) || Array.from(trimmed).length > 200) {
      return {
        error: invalid(
          `"${trimmed}" is not a valid font name.`,
          `« ${trimmed} » n'est pas un nom de police valide.`,
        ),
      };
    }
    fonts.push(trimmed || null);
  }
  const branches: string[] = [];
  for (const raw of prefs.protectedBranches) {
    const pattern = raw.trim();
    if (!pattern || branches.includes(pattern)) continue;
    if (/[\s\p{Cc}]/u.test(pattern) || Array.from(pattern).length > 200) {
      return {
        error: invalid(
          `"${pattern}" is not a valid branch name or pattern.`,
          `« ${pattern} » n'est pas un nom ou un motif de branche valide.`,
        ),
      };
    }
    branches.push(pattern);
  }
  if (branches.length > MAX_PROTECTED_BRANCHES) {
    return {
      error: invalid(
        `At most ${String(MAX_PROTECTED_BRANCHES)} protected branches are supported.`,
        `${String(MAX_PROTECTED_BRANCHES)} branches protégées au plus sont prises en charge.`,
      ),
    };
  }
  const clean = (value: string | null): string | null => value?.trim() || null;
  const editor = clean(prefs.editor);
  if (
    editor !== null &&
    (editor.length > 512 || /\p{Cc}/u.test(editor) || editor.startsWith('-'))
  ) {
    return {
      error: invalid(
        'The editor must be a program or application name, or a path.',
        "L'éditeur doit être un nom de programme ou d'application, ou un chemin.",
      ),
    };
  }
  for (const tool of [clean(prefs.diffTool), clean(prefs.mergeTool)]) {
    if (tool !== null && !isToolName(tool)) {
      return {
        error: invalid(
          `"${tool}" is not a valid tool name (letters, digits, - _ . + only).`,
          `« ${tool} » n'est pas un nom d'outil valide (lettres, chiffres, - _ . + seulement).`,
        ),
      };
    }
  }
  const claudePath = prefs.claudePath?.trim() || null;
  if (
    claudePath !== null &&
    (claudePath.length > 1024 || /\p{Cc}/u.test(claudePath) || claudePath.startsWith('-'))
  ) {
    return {
      error: invalid(
        'The Claude Code path must be a program name or a path.',
        'Le chemin de Claude Code doit être un nom de programme ou un chemin.',
      ),
    };
  }
  const ai = normalizeAi(prefs.ai ?? DEFAULT_AI_PREFERENCES);
  if ('error' in ai) return ai;
  const disabled = prefs.disabledConfirmations.filter(
    (kind, index, all) => kind !== 'forcePush' && all.indexOf(kind) === index,
  );
  return {
    ok: {
      ...prefs,
      uiFont: fonts[0] ?? null,
      codeFont: fonts[1] ?? null,
      gitPath: prefs.gitPath?.trim() || null,
      editor,
      diffTool: clean(prefs.diffTool),
      mergeTool: clean(prefs.mergeTool),
      protectedBranches: branches,
      disabledConfirmations: disabled,
      gravatar: prefs.gravatar ?? false,
      remoteTags: prefs.remoteTags ?? false,
      aiEnabled: prefs.aiEnabled ?? false,
      claudePath,
      ai: ai.ok,
    },
  };
}

/** Message of `YagguiError::git_binary_invalid`. */
export function gitBinaryInvalid(path: string): YagguiError {
  return error(
    'gitBinaryInvalid',
    `"${path}" is not a working Git: the file must exist and answer to --version.`,
    `« ${path} » n'est pas un Git utilisable : le fichier doit exister et répondre à --version.`,
  );
}

const DETECTED_GIT = '/usr/bin/git';

/**
 * What the mock says about a Git path: paths containing `missing` or `invalid` do not work,
 * `old` ones are too old (< 2.30), anything else is a working 2.47.1.
 */
export function mockGitBinaryInfo(path: string | null): GitBinaryInfo {
  const requested = path?.trim() || null;
  const shown = requested ?? DETECTED_GIT;
  const base = { path: shown, minVersion: '2.30' };
  if (/missing|invalid/.test(shown)) {
    return { ...base, version: null, supported: false, error: gitBinaryInvalid(shown) };
  }
  if (/old/.test(shown)) {
    return { ...base, version: '2.25.1', supported: false, error: null };
  }
  return { ...base, version: '2.47.1', supported: true, error: null };
}

export function isMockGitPathValid(path: string): boolean {
  return mockGitBinaryInfo(path).error === null;
}

const CLONE_PHASES: readonly [string, number][] = [
  ['Receiving objects', 12],
  ['Receiving objects', 47],
  ['Receiving objects', 83],
  ['Receiving objects', 100],
  ['Resolving deltas', 100],
];

interface RunningClone {
  cancel: () => void;
}

/**
 * Mock of clone and init. The address decides the outcome, so tests need no setup:
 * `slow` never ends until cancelled, `auth`, `unreachable` and `notfound` fail like the
 * backend would, and a target containing `busy` is a folder that already has files.
 */
export class MockCreator {
  /** Delay between two progress steps of a clone, in ms. */
  stepMs = 120;
  private lastParent: string | null = null;
  private running = new Map<string, RunningClone>();
  /** Targets and options of the clones that succeeded, for tests. */
  readonly clones: CloneRequest[] = [];
  readonly inits: InitRequest[] = [];

  constructor(
    private readonly emit: (progress: CloneProgress) => void,
    private readonly defaultBranch = 'main',
  ) {}

  reset(): void {
    this.running.forEach((clone) => {
      clone.cancel();
    });
    this.running.clear();
    this.clones.length = 0;
    this.inits.length = 0;
    this.lastParent = null;
    this.stepMs = 120;
  }

  defaults(): NewRepoDefaults {
    return { parentDir: this.lastParent ?? '/Users/alex/dev', defaultBranch: this.defaultBranch };
  }

  cancelClone(cloneId: string): void {
    this.running.get(cloneId)?.cancel();
  }

  clone(request: CloneRequest): Promise<IpcResult<CloneResult>> {
    const url = request.url.trim();
    const fail = (e: YagguiError) =>
      Promise.resolve<IpcResult<CloneResult>>({ status: 'error', error: e });
    if (!url || url.startsWith('-')) {
      return fail(
        invalid(
          'Enter the address of the repository to clone.',
          'Saisis l’adresse du dépôt à cloner.',
        ),
      );
    }
    if (!/^([/\\]|[a-z]:[\\/])/i.test(request.target)) {
      return fail(
        invalid(
          `Expected an absolute folder path, got "${request.target}".`,
          `Chemin de dossier absolu attendu, reçu « ${request.target} ».`,
        ),
      );
    }
    if (/busy/.test(request.target)) {
      return fail(
        error(
          'targetNotEmpty',
          `The folder ${request.target} already exists and is not empty. Choose another folder, or an empty one.`,
          `Le dossier ${request.target} existe déjà et n'est pas vide. Choisis un autre dossier, ou un dossier vide.`,
        ),
      );
    }
    return new Promise((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (result: IpcResult<CloneResult>) => {
        timers.forEach(clearTimeout);
        this.running.delete(request.cloneId);
        resolve(result);
      };
      this.running.set(request.cloneId, {
        cancel: () => {
          finish({
            status: 'error',
            error: error('cancelled', 'Operation cancelled.', 'Opération annulée.'),
          });
        },
      });
      const step = (index: number) => {
        const phase = CLONE_PHASES[index];
        if (!phase) {
          this.lastParent = request.target.replace(/[\\/][^\\/]+$/, '') || '/';
          this.clones.push(request);
          finish({ status: 'ok', data: { path: request.target } });
          return;
        }
        this.emit({
          cloneId: request.cloneId,
          phase: phase[0],
          percent: phase[1],
          current: phase[1] * 10,
          total: 1000,
        });
        // `slow` stops half way and waits for a cancellation.
        if (/slow/.test(url) && index === 1) return;
        timers.push(
          setTimeout(() => {
            step(index + 1);
          }, this.stepMs),
        );
      };
      const failure = this.cloneFailure(url, request.branch);
      if (failure) {
        timers.push(
          setTimeout(() => {
            finish({ status: 'error', error: failure });
          }, this.stepMs),
        );
        return;
      }
      timers.push(
        setTimeout(() => {
          step(0);
        }, this.stepMs),
      );
    });
  }

  private cloneFailure(url: string, branch: string | null): YagguiError | null {
    // Same errors as the backend's catalog (`git/errors.rs`), with Git's own line as detail.
    if (/auth/.test(url)) {
      return {
        ...authFailed(/^(ssh:|git@)/.test(url)),
        detail: "fatal: Authentication failed for 'https://example.com/team/private.git/'",
      };
    }
    if (/unreachable/.test(url)) {
      return {
        ...hostUnreachable(),
        detail:
          "fatal: unable to access 'https://git.invalid/team/app.git/': Could not resolve host: git.invalid",
      };
    }
    if (/notfound/.test(url)) return remoteNotFound();
    if (branch && /nobranch/.test(branch)) {
      return error(
        'remoteBranchNotFound',
        `The branch "${branch}" does not exist on the remote.`,
        `La branche « ${branch} » n'existe pas sur le serveur.`,
      );
    }
    return null;
  }

  init(request: InitRequest): Promise<IpcResult<InitResult>> {
    const fail = (e: YagguiError) =>
      Promise.resolve<IpcResult<InitResult>>({ status: 'error', error: e });
    const branch = request.defaultBranch.trim();
    if (!isValidRefName(branch) || branch === 'HEAD') {
      return fail(invalidRefName(branch, 'branch'));
    }
    if (/existing-repo/.test(request.target)) {
      return fail(
        error(
          'alreadyRepository',
          `${request.target} already is a Git repository.`,
          `${request.target} est déjà un dépôt Git.`,
        ),
      );
    }
    this.lastParent = request.target.replace(/[\\/][^\\/]+$/, '') || '/';
    this.inits.push(request);
    const createdFiles = [
      ...(request.gitignore.length > 0 ? ['.gitignore'] : []),
      ...(request.readme ? ['README.md'] : []),
    ];
    return Promise.resolve({ status: 'ok', data: { path: request.target, createdFiles } });
  }
}
