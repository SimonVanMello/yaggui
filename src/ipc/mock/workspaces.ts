import type {
  YagguiError,
  ScanProgress,
  ScanRequest,
  ScanResult,
  ScannedRepo,
  Workspace,
} from '../bindings';
import { SCAN_DEPTH_MAX, SCAN_DEPTH_MIN, WORKSPACE_NAME_MAX } from '../bindings';
import type { IpcResult } from '../result';

function error(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

function invalid(en: string, fr: string): YagguiError {
  return error('invalidArgument', en, fr);
}

export function unknownWorkspace(id: number): YagguiError {
  return invalid(`Unknown workspace #${String(id)}.`, `Workspace n°${String(id)} inconnu.`);
}

/** Same checks as `clean_name` / `check_unique` in `store/workspaces.rs`. */
export function checkWorkspaceName(
  name: string,
  workspaces: readonly Workspace[],
  except: number | null,
): { ok: string } | { error: YagguiError } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { error: invalid('The workspace needs a name.', 'Le workspace doit avoir un nom.') };
  }
  if (Array.from(trimmed).length > WORKSPACE_NAME_MAX || /\p{Cc}/u.test(trimmed)) {
    const max = String(WORKSPACE_NAME_MAX);
    return {
      error: invalid(
        `A workspace name has at most ${max} characters, without control characters.`,
        `Un nom de workspace compte au plus ${max} caractères, sans caractère de contrôle.`,
      ),
    };
  }
  const lower = trimmed.toLowerCase();
  if (workspaces.some((w) => w.id !== except && w.name.toLowerCase() === lower)) {
    return {
      error: invalid(
        `A workspace named "${trimmed}" already exists.`,
        `Un workspace nommé « ${trimmed} » existe déjà.`,
      ),
    };
  }
  return { ok: trimmed };
}

/** Sorted like `list_workspaces`: by name, case-insensitive. */
export function sortWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return [...workspaces].sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id,
  );
}

/** Two workspaces over the mock repos; `Personal` holds the missing `legacy-api` (F-009). */
export function createMockWorkspaces(): Workspace[] {
  return [
    { id: 1, name: 'Personal', repoIds: [1, 3, 4] },
    { id: 2, name: 'Kernel', repoIds: [2] },
  ];
}

/** Last fetch of the mock repos (`FETCH_HEAD` mtime), relative to `MOCK_NOW`. */
export const MOCK_LAST_FETCH_AGO: Record<number, number | undefined> = {
  1: 1_800,
  2: 86_400 * 2,
};

/**
 * Folders found by a mock scan, relative to the scanned root, with their depth (number of
 * segments). Any root works; a root containing `missing` does not exist, `empty` has nothing.
 */
const MOCK_TREE = [
  'yaggui',
  'linux',
  'api-gateway',
  'web-app',
  'clients/acme-portal',
  'clients/acme-mobile',
  'sandbox/experiments/rust-play',
];

const SCAN_STEPS = 6;

/** Folder scans (F-007) with progress and cancellation, paced by `stepMs`. */
export class MockScanner {
  stepMs = 150;
  private running = new Map<string, () => void>();

  constructor(
    private readonly emit: (progress: ScanProgress) => void,
    private readonly knownIdOf: (path: string) => number | null,
  ) {}

  reset(): void {
    this.running.forEach((cancel) => {
      cancel();
    });
    this.running.clear();
    this.stepMs = 150;
  }

  cancel(scanId: string): void {
    this.running.get(scanId)?.();
  }

  scan(request: ScanRequest): Promise<IpcResult<ScanResult>> {
    const root = request.root.trim().replace(/(.)[\\/]+$/, '$1');
    if (!root.startsWith('/') && !/^[a-z]:[\\/]/i.test(root)) {
      return Promise.resolve({
        status: 'error',
        error: invalid(
          `Expected an absolute folder path, got "${request.root}".`,
          `Chemin de dossier absolu attendu, reçu « ${request.root} ».`,
        ),
      });
    }
    if (/missing/.test(root)) {
      return Promise.resolve({
        status: 'error',
        error: error(
          'repoNotFound',
          `The folder ${root} does not exist.`,
          `Le dossier ${root} n'existe pas.`,
        ),
      });
    }
    if (request.maxDepth < SCAN_DEPTH_MIN || request.maxDepth > SCAN_DEPTH_MAX) {
      const [min, max] = [String(SCAN_DEPTH_MIN), String(SCAN_DEPTH_MAX)];
      return Promise.resolve({
        status: 'error',
        error: invalid(
          `The depth must be between ${min} and ${max}.`,
          `La profondeur doit être comprise entre ${min} et ${max}.`,
        ),
      });
    }
    if (!request.scanId || this.running.has(request.scanId)) {
      return Promise.resolve({
        status: 'error',
        error: invalid('This scan is already running.', 'Ce scan est déjà en cours.'),
      });
    }
    const repos: ScannedRepo[] = /empty/.test(root)
      ? []
      : MOCK_TREE.filter((rel) => rel.split('/').length <= request.maxDepth)
          .map((rel) => {
            const path = `${root}/${rel}`;
            return { path, name: rel.split('/').pop() ?? rel, knownId: this.knownIdOf(path) };
          })
          // Byte order, like `sort_by` on the Rust strings.
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const visited = 12 + request.maxDepth * 40;
    return new Promise((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (result: IpcResult<ScanResult>) => {
        timers.forEach(clearTimeout);
        this.running.delete(request.scanId);
        resolve(result);
      };
      this.running.set(request.scanId, () => {
        finish({
          status: 'error',
          error: error('cancelled', 'Operation cancelled.', 'Opération annulée.'),
        });
      });
      for (let step = 0; step <= SCAN_STEPS; step++) {
        timers.push(
          setTimeout(() => {
            const found = Math.round((repos.length * step) / SCAN_STEPS);
            this.emit({
              scanId: request.scanId,
              visited: Math.round((visited * step) / SCAN_STEPS),
              found,
              current: repos[Math.max(0, found - 1)]?.path ?? root,
            });
            if (step === SCAN_STEPS) {
              finish({ status: 'ok', data: { repos, visited, truncated: false } });
            }
          }, this.stepMs * step),
        );
      }
    });
  }
}
