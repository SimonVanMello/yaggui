import type { YagguiError } from '../bindings';

/** Errors of the network commands, with the messages of `git/errors.rs`. */
function mockError(
  code: YagguiError['code'],
  en: string,
  fr: string,
  action: YagguiError['action'] = null,
): YagguiError {
  return { code, message: { en, fr }, action, detail: null, payload: null };
}

/** Same matching as `is_protected_branch` in `git/ops/types.rs`: `patterns` is a preference. */
export function isProtectedBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('/*')
      ? branch.startsWith(pattern.slice(0, -1)) && branch.length > pattern.length - 1
      : branch === pattern,
  );
}

export function pushRejected(): YagguiError {
  return mockError(
    'pushRejected',
    "Push rejected: the remote branch has commits you don't have.",
    "Push rejeté : la branche distante contient des commits que tu n'as pas.",
    { kind: 'pullThenPush' },
  );
}

export function protectedBranch(name: string): YagguiError {
  return mockError(
    'protectedBranch',
    `"${name}" is a protected branch: force push is refused.`,
    `« ${name} » est une branche protégée : le force push est refusé.`,
  );
}

export function noUpstream(branch: string): YagguiError {
  return mockError(
    'noUpstream',
    `"${branch}" has no upstream branch.`,
    `« ${branch} » n'a pas de branche amont (upstream).`,
    { kind: 'pushSetUpstream' },
  );
}

export function notFastForward(): YagguiError {
  return mockError(
    'notFastForward',
    'Your branch and its upstream diverged: a fast-forward is impossible. Pull with merge or rebase.',
    "Ta branche et son upstream ont divergé : impossible d'avancer en fast-forward. Fais un pull en merge ou en rebase.",
  );
}

export function remoteNotFound(): YagguiError {
  return mockError(
    'remoteNotFound',
    'Remote not found: check its name and URL.',
    'Remote introuvable : vérifie son nom et son URL.',
  );
}

export function authFailed(ssh = false): YagguiError {
  return ssh
    ? mockError(
        'authFailed',
        'SSH authentication failed. Load your key in ssh-agent (ssh-add) and check that the remote knows it.',
        'Authentification SSH refusée. Charge ta clé dans ssh-agent (ssh-add) et vérifie que le remote la connaît.',
      )
    : mockError(
        'authFailed',
        'Authentication failed. yaggui never asks for passwords: configure a Git credential helper (git config credential.helper) and sign in once from a terminal.',
        'Authentification refusée. yaggui ne demande jamais de mot de passe : configure un credential helper Git (git config credential.helper) et connecte-toi une fois depuis un terminal.',
      );
}

/** URL of the remote added by `MockBackend.addOfflineRemote`. */
export const OFFLINE_REMOTE_URL = 'https://offline.invalid/repo.git';

export function hostUnreachable(): YagguiError {
  return {
    ...mockError(
      'hostUnreachable',
      "The remote host can't be reached. Check your connection and the remote URL.",
      "L'hôte distant est injoignable. Vérifie ta connexion et l'URL du remote.",
      { kind: 'retry' },
    ),
    // Like the backend, the error carries git's stderr (also written to the command log).
    detail: `fatal: unable to access '${OFFLINE_REMOTE_URL}/': Could not resolve host: offline.invalid`,
  };
}

/** Network progress phases emitted by the mock while a fetch, pull or push runs. */
export const MOCK_NETWORK_PHASES: [string, number][] = [
  ['Counting objects', 100],
  ['Receiving objects', 30],
  ['Receiving objects', 70],
  ['Receiving objects', 100],
  ['Resolving deltas', 100],
];
