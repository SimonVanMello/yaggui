import type {
  AiContextPreview,
  AiContextSummary,
  AiCredential,
  AiPreferences,
  AiProviderKind,
  AiProviderStatus,
  AiSkill,
  AiStatus,
  AiTestResult,
  ApiKeySource,
  ErrorAction,
  GeneratedCommitMessage,
  YagguiError,
} from '../bindings';
import {
  AI_DIFF_BYTES_MAX,
  AI_DIFF_BYTES_MIN,
  AI_FILE_BYTES_MAX,
  AI_FILE_BYTES_MIN,
  AI_PROMPT_MAX,
  AI_RECENT_SUBJECTS_MAX,
  AI_TIMEOUT_MAX,
  AI_TIMEOUT_MIN,
} from '../bindings';

import { DEFAULT_AI_PREFERENCES } from '../aiDefaults';

const MOCK_DEFAULT_PROMPT = `You write Git commit messages.

Write a short summary line in the imperative mood (50 characters or fewer when you can, 72 at most), then, only when the change deserves it, a blank line and a description that explains what changed and why.

Follow the style of the recent subjects when they are given. Answer with the message alone: no quotes, no code fence, no comment.`;

export function mockDefaultPrompt(): string {
  return MOCK_DEFAULT_PROMPT;
}

function error(
  code: YagguiError['code'],
  en: string,
  fr: string,
  action: ErrorAction | null = null,
  detail: string | null = null,
): YagguiError {
  return { code, message: { en, fr }, action, detail, payload: null };
}

function invalid(en: string, fr: string): YagguiError {
  return error('invalidArgument', en, fr);
}

const CONFIGURE_AI: ErrorAction = { kind: 'configureAi' };
const RETRY: ErrorAction = { kind: 'retry' };

/** `YagguiError::ai_*` in `git/errors.rs`: same codes, messages and suggested actions. */
export function mockAiError(code: AiErrorCode, cli = false): YagguiError {
  switch (code) {
    case 'aiDisabled':
      return error(
        code,
        'AI commit messages are turned off. Turn them on in the preferences (AI).',
        'Les messages de commit par IA sont désactivés. Active-les dans les préférences (IA).',
        CONFIGURE_AI,
      );
    case 'aiNotConfigured':
      return cli
        ? error(
            code,
            'Claude Code was not found. Install it, or set its path in the preferences (AI).',
            'Claude Code est introuvable. Installe-le, ou indique son chemin dans les préférences (IA).',
            CONFIGURE_AI,
          )
        : error(
            code,
            'No API key: save one in the preferences (AI), or set the ANTHROPIC_API_KEY environment variable.',
            'Aucune clé d’API : enregistre-en une dans les préférences (IA), ou définis la variable d’environnement ANTHROPIC_API_KEY.',
            CONFIGURE_AI,
          );
    case 'aiAuthFailed':
      return cli
        ? error(
            code,
            'Claude Code is not logged in, or its login expired. Run claude in a terminal and log in, then try again.',
            'Claude Code n’est pas connecté, ou sa connexion a expiré. Lance claude dans un terminal et connecte-toi, puis réessaie.',
            CONFIGURE_AI,
            'authentication_error',
          )
        : error(
            code,
            'The API key was refused. Check it, or save a new one in the preferences (AI).',
            'La clé d’API a été refusée. Vérifie-la, ou enregistre-en une nouvelle dans les préférences (IA).',
            CONFIGURE_AI,
            'HTTP 401 invalid x-api-key',
          );
    case 'aiRateLimited':
      return error(
        code,
        'The AI provider limits requests right now (rate or spending limit). Try again in a moment.',
        'Le fournisseur d’IA limite les requêtes en ce moment (débit ou plafond de dépenses). Réessaie dans un instant.',
        RETRY,
        'HTTP 429 rate_limit_error',
      );
    case 'aiProviderUnavailable':
      return error(
        code,
        'The AI provider could not be reached or is overloaded. Check the connection and try again.',
        'Le fournisseur d’IA est injoignable ou surchargé. Vérifie la connexion et réessaie.',
        RETRY,
        'HTTP 529 overloaded_error',
      );
    case 'aiTimeout':
      return error(
        code,
        'The AI provider did not answer in time. Try again, or raise the time limit in the preferences (AI).',
        'Le fournisseur d’IA n’a pas répondu à temps. Réessaie, ou augmente le délai dans les préférences (IA).',
        RETRY,
      );
    case 'aiEmptyResponse':
      return error(
        code,
        'The AI provider answered without a commit message. Try again.',
        'Le fournisseur d’IA a répondu sans message de commit. Réessaie.',
        RETRY,
      );
    case 'aiProviderFailed':
      return error(
        code,
        'The AI provider reported an error. Its answer is in the details; check the model and the settings in the preferences (AI).',
        'Le fournisseur d’IA a signalé une erreur. Sa réponse est dans les détails ; vérifie le modèle et les réglages dans les préférences (IA).',
        CONFIGURE_AI,
        'model: not_found_error',
      );
    case 'aiKeychainUnavailable':
      return error(
        code,
        'The system keychain cannot be used, so the key cannot be saved. Set the ANTHROPIC_API_KEY environment variable instead.',
        'Le trousseau du système est inutilisable, la clé ne peut donc pas être enregistrée. Définis plutôt la variable d’environnement ANTHROPIC_API_KEY.',
        null,
        'No secret service',
      );
    case 'aiBusy':
      return error(
        code,
        'A commit message is already being generated for this repository.',
        'Un message de commit est déjà en cours de génération pour ce dépôt.',
      );
  }
}

export type AiErrorCode = Extract<YagguiError['code'], `ai${string}`>;

function nothingStaged(): YagguiError {
  return error(
    'nothingToCommit',
    'Nothing is staged: stage the changes to describe first.',
    'Rien n’est indexé : indexe d’abord les modifications à décrire.',
  );
}

function cancelled(): YagguiError {
  return error('cancelled', 'Operation cancelled.', 'Opération annulée.');
}

function plainName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    !/^[-./]/.test(name) &&
    /^[A-Za-z0-9\-_.:@/[\]]+$/.test(name)
  );
}

function checkRange(
  value: number,
  min: number,
  max: number,
  en: string,
  fr: string,
): YagguiError | null {
  if (Number.isInteger(value) && value >= min && value <= max) return null;
  return invalid(
    `${en} must be between ${String(min)} and ${String(max)}.`,
    `${fr} : une valeur entre ${String(min)} et ${String(max)} est attendue.`,
  );
}

/** `AiPreferences::normalized` in `ai/prefs.rs`. */
export function normalizeAi(input: AiPreferences): { ok: AiPreferences } | { error: YagguiError } {
  const ai: AiPreferences = {
    ...input,
    claudeApi: { ...input.claudeApi },
    claudeCode: { ...input.claudeCode },
  };
  const ranges = [
    checkRange(
      ai.maxDiffBytes,
      AI_DIFF_BYTES_MIN,
      AI_DIFF_BYTES_MAX,
      'Maximum diff size',
      'Taille maximale du diff',
    ),
    checkRange(
      ai.maxFileBytes,
      AI_FILE_BYTES_MIN,
      AI_FILE_BYTES_MAX,
      'Maximum size per file',
      'Taille maximale par fichier',
    ),
    checkRange(ai.recentSubjects, 0, AI_RECENT_SUBJECTS_MAX, 'Recent subjects', 'Sujets récents'),
    checkRange(
      ai.timeoutSeconds,
      AI_TIMEOUT_MIN,
      AI_TIMEOUT_MAX,
      'Time limit (seconds)',
      'Délai (secondes)',
    ),
  ];
  for (const failure of ranges) if (failure) return { error: failure };

  const nameError = (name: string, kind: 'model' | 'skill') =>
    invalid(
      `"${name}" is not a valid ${kind === 'skill' ? 'skill' : 'model'} name (letters, digits, - _ . : @ / only).`,
      `« ${name} » n'est pas un ${kind === 'skill' ? 'nom de skill' : 'nom de modèle'} valide (lettres, chiffres, - _ . : @ / seulement).`,
    );
  const model = ai.claudeApi.model.trim();
  if (model !== '' && !plainName(model)) return { error: nameError(model, 'model') };
  ai.claudeApi.model = model || DEFAULT_AI_PREFERENCES.claudeApi.model;
  for (const key of ['model', 'skill'] as const) {
    const value = ai.claudeCode[key]?.trim() || null;
    if (value !== null && !plainName(value)) return { error: nameError(value, key) };
    ai.claudeCode[key] = value;
  }

  ai.customPrompt = ai.customPrompt?.trim() ? ai.customPrompt : null;
  if (ai.customPrompt !== null && Array.from(ai.customPrompt).length > AI_PROMPT_MAX) {
    return {
      error: invalid(
        `The prompt is limited to ${String(AI_PROMPT_MAX)} characters.`,
        `Le prompt est limité à ${String(AI_PROMPT_MAX)} caractères.`,
      ),
    };
  }
  const patterns: string[] = [];
  for (const raw of ai.excludedPaths) {
    const pattern = raw.trim();
    if (!pattern || patterns.includes(pattern)) continue;
    if (Array.from(pattern).length > 200 || /\p{Cc}/u.test(pattern)) {
      return {
        error: invalid(
          `"${pattern}" is not a valid path pattern.`,
          `« ${pattern} » n'est pas un motif de chemin valide.`,
        ),
      };
    }
    patterns.push(pattern);
  }
  if (patterns.length > 200) {
    return {
      error: invalid(
        'At most 200 excluded paths are supported.',
        '200 chemins exclus au plus sont pris en charge.',
      ),
    };
  }
  ai.excludedPaths = patterns;
  return { ok: ai };
}

/** A pattern without `/` matches the file name anywhere, else the path from the root. */
export function matchesExcluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const target = pattern.includes('/') ? path : (path.split('/').pop() ?? path);
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('**', '\u0000')
      .replaceAll('*', '[^/]*')
      .replaceAll('\u0000', '.*');
    return new RegExp(`^${source}$`).test(target);
  });
}

/** What the mock knows about a changed file: enough to write a plausible message. */
export interface MockChangedFile {
  path: string;
  status: string;
  /** Size of the diff in bytes. */
  bytes: number;
  binary: boolean;
}

export interface MockAiRepo {
  name: string;
  branch: string | null;
  files: MockChangedFile[];
  subjects: string[];
}

/** Conventional Commits header guessed from the paths, like a model would from the diff. */
export function guessMessage(
  files: readonly MockChangedFile[],
  language: 'en' | 'fr',
): { summary: string; description: string } {
  const fr = language === 'fr';
  if (files.length === 0) {
    return {
      summary: fr ? 'chore: réécrire le message' : 'chore: reword the commit',
      description: '',
    };
  }
  const only = (test: (path: string) => boolean) => files.every((f) => test(f.path));
  const type = only((p) => /\.(md|mdx)$|^docs\//.test(p))
    ? 'docs'
    : only((p) => /\.test\.|\.spec\.|^tests?\//.test(p))
      ? 'test'
      : only((p) => /\.(css|scss)$/.test(p))
        ? 'style'
        : files.every((f) => f.status === 'added')
          ? 'feat'
          : files.some((f) => f.status === 'added')
            ? 'feat'
            : 'fix';
  const dirs = files.map((f) => {
    const parts = f.path.split('/');
    return parts.length > 3 && parts[0] === 'src' ? (parts[2] ?? '') : parts[1] ? parts[0] : '';
  });
  const scope = dirs.every((d) => d === dirs[0]) ? (dirs[0] ?? '') : '';
  const first = files[0];
  const base = (first?.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const subject =
    files.length === 1
      ? fr
        ? `${type === 'feat' ? 'ajouter' : 'corriger'} ${base}`
        : `${type === 'feat' ? 'add' : 'fix'} ${base}`
      : fr
        ? `mettre à jour ${String(files.length)} fichiers${scope ? ` de ${scope}` : ''}`
        : `update ${String(files.length)} files${scope ? ` in ${scope}` : ''}`;
  const lines = files.slice(0, 6).map((f) => `- ${f.status} ${f.path}`);
  if (files.length > 6) {
    lines.push(
      fr ? `- … et ${String(files.length - 6)} autres` : `- … and ${String(files.length - 6)} more`,
    );
  }
  return {
    summary: `${type}${scope ? `(${scope})` : ''}: ${subject}`,
    description: `${fr ? 'Modifications :' : 'Changes:'}\n${lines.join('\n')}`,
  };
}

/** Which of `files` the context carries in full, cut, or by name only. */
export function summarizeContext(
  files: readonly MockChangedFile[],
  ai: AiPreferences,
): AiContextSummary {
  const summary: AiContextSummary = {
    files: files.length,
    truncatedFiles: [],
    excludedFiles: [],
    binaryFiles: [],
    omittedFiles: [],
    sentBytes: 0,
  };
  let budget = ai.maxDiffBytes;
  let sent = 0;
  for (const file of files) {
    if (matchesExcluded(file.path, ai.excludedPaths)) summary.excludedFiles.push(file.path);
    else if (file.binary) summary.binaryFiles.push(file.path);
    else if (budget <= 0) summary.omittedFiles.push(file.path);
    else {
      const cut = Math.min(file.bytes, ai.maxFileBytes, budget);
      if (cut < file.bytes) summary.truncatedFiles.push(file.path);
      budget -= cut;
      sent += cut;
    }
  }
  summary.sentBytes = sent + files.length * 40 + MOCK_DEFAULT_PROMPT.length;
  return summary;
}

function contextText(repo: MockAiRepo, ai: AiPreferences, summary: AiContextSummary): string {
  const instructions = ai.customPrompt ?? MOCK_DEFAULT_PROMPT;
  const subjects = repo.subjects.slice(0, ai.recentSubjects);
  const named = new Set([
    ...summary.excludedFiles,
    ...summary.binaryFiles,
    ...summary.omittedFiles,
  ]);
  return [
    instructions,
    '',
    `Branch: ${repo.branch ?? '(detached HEAD)'}`,
    ...(subjects.length ? ['', 'Recent subjects:', ...subjects.map((s) => `- ${s}`)] : []),
    '',
    'Changed files:',
    ...repo.files.map((f) => `${f.status}\t${f.path}`),
    '',
    ...repo.files
      .filter((f) => !named.has(f.path))
      .flatMap((f) => [
        `diff --git a/${f.path} b/${f.path}`,
        summary.truncatedFiles.includes(f.path) ? '(diff cut)' : '@@ …',
      ]),
  ].join('\n');
}

const SUGGESTED_MODELS: Record<AiProviderKind, string[]> = {
  claudeApi: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  claudeCode: ['haiku', 'sonnet', 'opus'],
};

const MOCK_SKILLS: AiSkill[] = [
  {
    name: 'commit',
    description: 'Write a commit message in the house style',
    scope: 'user',
    legacyCommand: false,
  },
  {
    name: 'conventional-commit',
    description: 'Conventional Commits with the repository scopes',
    scope: 'project',
    legacyCommand: false,
  },
  { name: 'changelog', description: null, scope: 'user', legacyCommand: true },
  {
    name: 'git-tools:commit',
    description: 'Commit helper of the git-tools plugin',
    scope: 'plugin',
    legacyCommand: false,
  },
];

export interface MockAiSetup {
  /** Where the API key comes from (`none` until the user saves one). */
  keySource: ApiKeySource;
  keychainAvailable: boolean;
  /** `claude` is installed (found on the PATH, or at the configured path). */
  claudeInstalled: boolean;
}

/** Latency of a generation, so the spinner and Cancel can be seen and tested. */
const DEFAULT_LATENCY_MS = 1500;

export interface LoggedAiCall {
  program: 'claude' | 'claude-api';
  args: string[];
  stdout: string;
  durationMs: number;
  status: 'success' | 'failed' | 'cancelled';
}

/** AI commit messages of the mock: providers, key and CLI state, and a fake generation. */
export class MockAi {
  setup!: MockAiSetup;
  /** Next generation / test fails with this code (consumed once unless `sticky`). */
  failure: { code: AiErrorCode; sticky: boolean } | null = null;
  latencyMs = DEFAULT_LATENCY_MS;
  /** Requests received by `aiGenerateCommitMessage`, for tests. */
  readonly generations: { repoId: number; amend: boolean }[] = [];
  private pending = new Map<number, () => void>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.pending.forEach((cancel) => {
      cancel();
    });
    this.pending.clear();
    this.setup = { keySource: 'none', keychainAvailable: true, claudeInstalled: true };
    this.failure = null;
    this.latencyMs = DEFAULT_LATENCY_MS;
    this.generations.length = 0;
  }

  claudePath(configured: string | null): string | null {
    if (configured) return /missing|invalid/.test(configured) ? null : configured;
    return this.setup.claudeInstalled ? '/usr/local/bin/claude' : null;
  }

  private credential(kind: AiProviderKind, configured: string | null): AiCredential {
    if (kind === 'claudeApi') {
      return {
        kind: 'apiKey',
        source: this.setup.keySource,
        keychainAvailable: this.setup.keychainAvailable,
        envVar: 'ANTHROPIC_API_KEY',
      };
    }
    const path = this.claudePath(configured);
    return {
      kind: 'cli',
      path,
      version: path ? '2.1.0 (Claude Code)' : null,
      configured: configured !== null && configured !== '',
    };
  }

  private providerStatus(kind: AiProviderKind, configured: string | null): AiProviderStatus {
    const credential = this.credential(kind, configured);
    const ready =
      credential.kind === 'apiKey' ? credential.source !== 'none' : credential.path !== null;
    return {
      kind,
      name: kind === 'claudeApi' ? 'Claude API' : 'Claude Code',
      defaultModel: kind === 'claudeApi' ? 'claude-haiku-5-5' : null,
      suggestedModels: SUGGESTED_MODELS[kind],
      supportsSkills: kind === 'claudeCode',
      credential,
      ready,
      problem: ready ? null : mockAiError('aiNotConfigured', kind === 'claudeCode'),
    };
  }

  status(claudePath: string | null): AiStatus {
    return {
      providers: [
        this.providerStatus('claudeApi', claudePath),
        this.providerStatus('claudeCode', claudePath),
      ],
    };
  }

  setApiKey(provider: AiProviderKind, key: string): YagguiError | null {
    if (provider !== 'claudeApi' || key.trim() === '' || /\s/.test(key.trim())) {
      return invalid('Enter a valid API key.', 'Saisis une clé d’API valide.');
    }
    if (!this.setup.keychainAvailable) return mockAiError('aiKeychainUnavailable');
    this.setup.keySource = 'keychain';
    return null;
  }

  clearApiKey(provider: AiProviderKind): YagguiError | null {
    if (provider !== 'claudeApi') {
      return invalid('This provider has no API key.', 'Ce fournisseur n’a pas de clé d’API.');
    }
    if (this.setup.keySource === 'keychain') this.setup.keySource = 'none';
    return null;
  }

  skills(repoId: number | null): AiSkill[] {
    const list = repoId === null ? MOCK_SKILLS.filter((s) => s.scope !== 'project') : MOCK_SKILLS;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The consumed simulated failure, if any. */
  private takeFailure(): AiErrorCode | null {
    const failure = this.failure;
    if (!failure) return null;
    if (!failure.sticky) this.failure = null;
    return failure.code;
  }

  private after<T>(
    key: number | null,
    ms: number,
    value: () => T,
  ): Promise<{ ok: T } | { error: YagguiError }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (key !== null) this.pending.delete(key);
        resolve({ ok: value() });
      }, ms);
      if (key !== null) {
        this.pending.set(key, () => {
          clearTimeout(timer);
          this.pending.delete(key);
          resolve({ error: cancelled() });
        });
      }
    });
  }

  async test(
    provider: AiProviderKind,
    ai: AiPreferences,
    claudePath: string | null,
  ): Promise<{ ok: AiTestResult; call: LoggedAiCall } | { error: YagguiError }> {
    const status = this.providerStatus(provider, claudePath);
    if (!status.ready && status.problem) return { error: status.problem };
    const code = this.takeFailure();
    if (code) return { error: mockAiError(code, provider === 'claudeCode') };
    const started = Date.now();
    const done = await this.after(null, Math.min(this.latencyMs, 600), () => 'OK');
    if ('error' in done) return done;
    const model =
      provider === 'claudeApi' ? ai.claudeApi.model : (ai.claudeCode.model ?? 'claude-sonnet-5-5');
    const durationMs = Math.max(Date.now() - started, 1);
    return {
      ok: { provider, model, durationMs, reply: done.ok },
      call: this.call(provider, model, durationMs, 'test', 'success'),
    };
  }

  private call(
    provider: AiProviderKind,
    model: string | null,
    durationMs: number,
    what: string,
    status: LoggedAiCall['status'],
    sizes = '',
  ): LoggedAiCall {
    const cli = provider === 'claudeCode';
    return {
      program: cli ? 'claude' : 'claude-api',
      args: cli
        ? ['-p', '--output-format', 'json', ...(model ? ['--model', model] : [])]
        : [`model=${model ?? ''}`, `purpose=${what}`],
      stdout: sizes || (status === 'success' ? `${what}: ok` : ''),
      durationMs,
      status,
    };
  }

  preview(repo: MockAiRepo, ai: AiPreferences): AiContextPreview {
    const summary = summarizeContext(repo.files, ai);
    return { text: contextText(repo, ai, summary), summary };
  }

  /**
   * Fake generation: waits `latencyMs` (cancellable by `cancel`), then writes a message from
   * the staged files. Checks run in the backend's order.
   */
  async generate(
    repoId: number,
    amend: boolean,
    repo: MockAiRepo,
    ai: AiPreferences,
    claudePath: string | null,
  ): Promise<
    { ok: GeneratedCommitMessage; call: LoggedAiCall } | { error: YagguiError; call?: LoggedAiCall }
  > {
    this.generations.push({ repoId, amend });
    if (this.pending.has(repoId)) return { error: mockAiError('aiBusy') };
    const status = this.providerStatus(ai.provider, claudePath);
    if (!status.ready && status.problem) return { error: status.problem };
    if (repo.files.length === 0 && !amend) return { error: nothingStaged() };
    const started = Date.now();
    const code = this.takeFailure();
    const done = await this.after(
      repoId,
      code ? Math.min(this.latencyMs, 700) : this.latencyMs,
      () => 0,
    );
    const durationMs = Math.max(Date.now() - started, 1);
    const model =
      ai.provider === 'claudeApi'
        ? ai.claudeApi.model
        : (ai.claudeCode.model ?? 'claude-sonnet-5-5');
    if ('error' in done) {
      return {
        error: done.error,
        call: this.call(ai.provider, model, durationMs, 'commit-message', 'cancelled'),
      };
    }
    if (code) {
      return {
        error: mockAiError(code, ai.provider === 'claudeCode'),
        call: this.call(ai.provider, model, durationMs, 'commit-message', 'failed'),
      };
    }
    const language = ai.language === 'auto' ? 'en' : ai.language;
    const context = summarizeContext(repo.files, ai);
    const message = guessMessage(repo.files, language);
    return {
      ok: { ...message, provider: ai.provider, model, durationMs, context },
      call: this.call(
        ai.provider,
        model,
        durationMs,
        'commit-message',
        'success',
        `sent ${String(context.sentBytes)} bytes, ${String(repo.files.length)} files`,
      ),
    };
  }

  cancel(repoId: number): void {
    this.pending.get(repoId)?.();
  }
}
