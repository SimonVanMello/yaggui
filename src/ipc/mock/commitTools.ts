import type {
  CommitMessage,
  CommitSettings,
  CommitTemplate,
  GitignoreRuleKind,
  YagguiError,
  IdentityProfile,
  RecentCommitMessage,
  SignatureCheck,
  SignatureKind,
} from '../bindings';

/** Same rules and messages as `store/commit_prefs.rs` and `git/ops/gitignore.rs`. */
function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

type Result<T> = { ok: T } | { error: YagguiError };

export const MOCK_RECENT_MESSAGES_KEPT = 30;
const MAX_LABEL = 100;

function oneLine(value: string, ident: boolean): string | null {
  const v = value.trim();
  if (!v || Array.from(v).length > MAX_LABEL * 3 || /[\n\r\0]/.test(v)) return null;
  if (ident && /[<>]/.test(v)) return null;
  return v;
}

/** Profiles, templates and recent messages: the store part of M4-7a. */
export class MockCommitStore {
  private profiles: IdentityProfile[] = [];
  private templates: CommitTemplate[] = [];
  private recent = new Map<number, RecentCommitMessage[]>();
  private nextId = 1;

  reset(seedRepoId: number | null): void {
    this.profiles = [
      { id: 1, label: 'Personal', name: 'Alex Martin', email: 'alex@example.com' },
      { id: 2, label: 'Work', name: 'Alex Martin', email: 'alex.martin@example.com' },
    ];
    this.templates = [{ id: 3, name: 'Bug fix', body: 'fix: \n\nCause:\nFix:\nRefs #' }];
    this.nextId = 4;
    this.recent = new Map();
    if (seedRepoId !== null) {
      const now = Date.now();
      this.recent.set(seedRepoId, [
        { message: 'feat(graph): draw merge lanes with rounded joints', usedAt: now - 3_600_000 },
        { message: 'fix(staging): keep the selection after a discard', usedAt: now - 7_200_000 },
        {
          message: 'refactor(ipc): split the mock client\n\nOne module per feature.',
          usedAt: now - 86_400_000,
        },
      ]);
    }
  }

  identityProfiles(): IdentityProfile[] {
    return [...this.profiles].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
  }

  saveIdentityProfile(profile: IdentityProfile): Result<IdentityProfile> {
    const label = oneLine(profile.label, false);
    const name = oneLine(profile.name, true);
    const email = oneLine(profile.email, true);
    if (
      !label ||
      Array.from(label).length > MAX_LABEL ||
      !name ||
      !email ||
      !email.includes('@') ||
      email.includes(' ')
    ) {
      return {
        error: mockError(
          'invalidArgument',
          'A profile needs a label, a name and an email address, each on one line.',
          'Un profil demande un libellé, un nom et une adresse e-mail, chacun sur une ligne.',
        ),
      };
    }
    if (profile.id !== null) {
      const index = this.profiles.findIndex((p) => p.id === profile.id);
      if (index < 0) return { error: unknown('profile', 'profil', profile.id) };
      const saved = { id: profile.id, label, name, email };
      this.profiles[index] = saved;
      return { ok: { ...saved } };
    }
    const saved = { id: this.nextId++, label, name, email };
    this.profiles.push(saved);
    return { ok: { ...saved } };
  }

  deleteIdentityProfile(id: number): void {
    this.profiles = this.profiles.filter((p) => p.id !== id);
  }

  commitTemplates(): CommitTemplate[] {
    return [...this.templates].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  saveCommitTemplate(template: CommitTemplate): Result<CommitTemplate> {
    const name = oneLine(template.name, false);
    if (!name || Array.from(name).length > MAX_LABEL) {
      return {
        error: mockError(
          'invalidArgument',
          'A template needs a name, on one line.',
          'Un modèle demande un nom, sur une ligne.',
        ),
      };
    }
    const body = template.body.trimEnd();
    if (!body.trim() || body.length > 16 * 1024) {
      return {
        error: mockError(
          'invalidArgument',
          'A template needs a text of at most 16384 bytes.',
          "Un modèle demande un texte d'au plus 16384 octets.",
        ),
      };
    }
    const clash = this.templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (clash && clash.id !== template.id) {
      return {
        error: mockError(
          'invalidArgument',
          `A template named "${name}" already exists.`,
          `Un modèle nommé « ${name} » existe déjà.`,
        ),
      };
    }
    if (template.id !== null) {
      const index = this.templates.findIndex((t) => t.id === template.id);
      if (index < 0) return { error: unknown('template', 'modèle', template.id) };
      const saved = { id: template.id, name, body };
      this.templates[index] = saved;
      return { ok: { ...saved } };
    }
    const saved = { id: this.nextId++, name, body };
    this.templates.push(saved);
    return { ok: { ...saved } };
  }

  deleteCommitTemplate(id: number): void {
    this.templates = this.templates.filter((t) => t.id !== id);
  }

  addRecentMessage(repoId: number, message: string): void {
    const text = message.trim();
    if (!text) return;
    const list = (this.recent.get(repoId) ?? []).filter((m) => m.message !== text);
    const last = list[0]?.usedAt ?? 0;
    list.unshift({ message: text, usedAt: Math.max(Date.now(), last + 1) });
    this.recent.set(repoId, list.slice(0, MOCK_RECENT_MESSAGES_KEPT));
  }

  recentMessages(repoId: number): RecentCommitMessage[] {
    return (this.recent.get(repoId) ?? []).map((m) => ({ ...m }));
  }
}

function unknown(en: string, fr: string, id: number): YagguiError {
  return mockError(
    'invalidArgument',
    `Unknown ${en} #${String(id)}.`,
    `${fr} n°${String(id)} inconnu.`,
  );
}

/** The commit message of `git commit -F`: summary, blank line, description. */
export function fullMessage(summary: string, description: string): string {
  const body = description.trimEnd().replace(/^[\r\n]+/, '');
  return body.trim() ? `${summary.trim()}\n\n${body}` : summary.trim();
}

/** `commit.template` and signing of a mock repo: the `yaggui` fixture signs with SSH. */
export function mockCommitSettings(repoName: string): CommitSettings {
  if (repoName !== 'yaggui') {
    return {
      template: null,
      templatePath: null,
      templateError: null,
      sign: null,
      signingKey: null,
    };
  }
  const template: CommitMessage = { summary: 'feat: ', description: 'Why:\n\nRefs #' };
  return {
    template,
    templatePath: '/Users/alex/.config/git/commit-template.txt',
    templateError: null,
    sign: 'ssh',
    signingKey: '~/.ssh/id_ed25519.pub',
  };
}

/** SSH signatures verify (allowed signers configured), GPG ones lack the public key. */
export function mockSignatureCheck(kind: SignatureKind | null): SignatureCheck {
  if (kind === null) return { status: 'unsigned', signer: null, key: null, reason: null };
  if (kind === 'ssh') {
    return {
      status: 'verified',
      signer: 'alex@example.com',
      key: 'SHA256:q3J1bXBsZS1rZXktZmluZ2VycHJpbnQtZm9yLWdyb3Zl',
      reason: null,
    };
  }
  return {
    status: 'unverified',
    signer: null,
    key: '4AEE18F83AFDEB23',
    reason: "gpg: Can't check signature: No public key",
  };
}

/** A `.gitignore` rule for one file and what it matches (`IgnoreRule` in Rust). */
export interface MockIgnoreRule {
  line: string;
  matches: (path: string) => boolean;
}

function escapeRule(literal: string): string {
  const escaped = literal.replace(/[\\*?[]/g, (c) => `\\${c}`);
  const trimmed = escaped.replace(/ +$/, '');
  return trimmed + '\\ '.repeat(escaped.length - trimmed.length);
}

export function mockIgnoreRule(path: string, kind: GitignoreRuleKind): Result<MockIgnoreRule> {
  const clean = path.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  const dir = slash < 0 ? '' : clean.slice(0, slash);
  const name = clean.slice(slash + 1);
  if (kind === 'file') {
    return { ok: { line: `/${escapeRule(clean)}`, matches: (p) => p === clean } };
  }
  if (kind === 'extension') {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot + 1 >= name.length) {
      return {
        error: mockError(
          'invalidArgument',
          `"${name}" has no extension.`,
          `« ${name} » n'a pas d'extension.`,
        ),
      };
    }
    const ext = name.slice(dot);
    return {
      ok: {
        line: `*${escapeRule(ext)}`,
        matches: (p) => (p.split('/').pop() ?? '').endsWith(ext),
      },
    };
  }
  if (!dir) {
    return {
      error: mockError(
        'invalidArgument',
        `"${clean}" is at the root of the repository: it has no folder to ignore.`,
        `« ${clean} » est à la racine du dépôt : il n'a pas de dossier à ignorer.`,
      ),
    };
  }
  return { ok: { line: `/${escapeRule(dir)}/`, matches: (p) => p.startsWith(`${dir}/`) } };
}

/** `.gitignore` with `line` appended on a line of its own. */
export function appendRule(current: string, line: string): string {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const base = current && !current.endsWith('\n') ? `${current}${eol}` : current;
  return `${base}${line}${eol}`;
}
