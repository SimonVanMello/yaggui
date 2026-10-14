import type { YagguiError, PtyExited, PtyInfo, PtyOutput } from '../bindings';

/** Errors of the integrated terminal, with the messages of `git/errors.rs`. */
function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

/** Prompt of the fake shell: the repository folder, like a real shell started in it. */
function prompt(cwd: string): string {
  const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  return `\x1b[32m${name}\x1b[0m \x1b[90m$\x1b[0m `;
}

interface MockPty {
  repoId: number;
  cwd: string;
  cols: number;
  rows: number;
  /** Line being typed (the fake shell has no line editing beyond backspace). */
  line: string;
}

export interface MockPtyEvents {
  output: (payload: PtyOutput) => void;
  exited: (payload: PtyExited) => void;
}

/** Same message as `YagguiError::terminal_closed`. */
export function terminalClosed(ptyId: number): YagguiError {
  return {
    ...mockError(
      'terminalClosed',
      'This terminal is closed: open a new one.',
      'Ce terminal est fermé : ouvres-en un nouveau.',
    ),
    detail: `pty ${String(ptyId)}`,
  };
}

/**
 * Fake shell of the integrated terminal (F-267) for `pnpm dev` and Playwright: echoes the
 * keys, and answers a few commands (`echo`, `pwd`, `git status`, `clear`, `exit`, `colors`).
 * Output is sent asynchronously, like the batched `pty-output` events of the backend.
 */
export class MockPtys {
  private ptys = new Map<number, MockPty>();
  private nextId = 1;
  /** Input received by each terminal, for tests. */
  readonly written = new Map<number, string>();
  /** Shell name reported by `spawn`. */
  shell = '/bin/zsh';
  /** `false` simulates a system where no shell can start. */
  available = true;

  constructor(private readonly events: MockPtyEvents) {}

  reset(): void {
    this.ptys.clear();
    this.written.clear();
    this.nextId = 1;
    this.shell = '/bin/zsh';
    this.available = true;
  }

  spawn(repoId: number, cwd: string, cols: number, rows: number): PtyInfo | YagguiError {
    if (!this.available) {
      return {
        ...mockError(
          'shellFailed',
          `The shell "${this.shell}" could not be started in the integrated terminal.`,
          `Le shell « ${this.shell} » n'a pas pu être lancé dans le terminal intégré.`,
        ),
        detail: 'No such file or directory (os error 2)',
      };
    }
    const ptyId = this.nextId++;
    this.ptys.set(ptyId, { repoId, cwd, cols, rows, line: '' });
    this.send(ptyId, `yaggui mock shell — ${this.shell}\r\n${prompt(cwd)}`);
    return { ptyId, shell: this.shell };
  }

  write(ptyId: number, data: string): YagguiError | null {
    const pty = this.ptys.get(ptyId);
    if (!pty) return terminalClosed(ptyId);
    this.written.set(ptyId, (this.written.get(ptyId) ?? '') + data);
    let echo = '';
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const command = pty.line.trim();
        pty.line = '';
        echo += '\r\n';
        if (command === 'exit') {
          this.send(ptyId, echo);
          this.exit(ptyId, 0);
          return null;
        }
        echo += this.run(pty, command) + prompt(pty.cwd);
      } else if (char === '\x7f' || char === '\b') {
        if (pty.line.length > 0) {
          pty.line = pty.line.slice(0, -1);
          echo += '\b \b';
        }
      } else if (char === '\x03') {
        pty.line = '';
        echo += `^C\r\n${prompt(pty.cwd)}`;
      } else if (char >= ' ') {
        pty.line += char;
        echo += char;
      }
    }
    if (echo) this.send(ptyId, echo);
    return null;
  }

  resize(ptyId: number, cols: number, rows: number): YagguiError | null {
    const pty = this.ptys.get(ptyId);
    if (!pty) return terminalClosed(ptyId);
    pty.cols = cols;
    pty.rows = rows;
    return null;
  }

  close(ptyId: number): void {
    if (this.ptys.has(ptyId)) this.exit(ptyId, null);
  }

  /** Ends every terminal of a repository, like `PtyManager::close_repo`. */
  closeRepo(repoId: number): void {
    for (const [ptyId, pty] of this.ptys) if (pty.repoId === repoId) this.exit(ptyId, null);
  }

  count(repoId: number): number {
    return [...this.ptys.values()].filter((pty) => pty.repoId === repoId).length;
  }

  size(ptyId: number): { cols: number; rows: number } | null {
    const pty = this.ptys.get(ptyId);
    return pty ? { cols: pty.cols, rows: pty.rows } : null;
  }

  private run(pty: MockPty, command: string): string {
    if (command === '') return '';
    if (command === 'pwd') return `${pty.cwd}\r\n`;
    if (command === 'clear') return '\x1b[2J\x1b[H';
    if (command === 'stty size') return `${String(pty.rows)} ${String(pty.cols)}\r\n`;
    if (command.startsWith('echo')) return `${command.slice(5)}\r\n`;
    if (command === 'git status') {
      return [
        'On branch \x1b[1mmain\x1b[0m',
        "Your branch is up to date with 'origin/main'.",
        '',
        'Changes not staged for commit:',
        '  (use "git add <file>..." to update what will be committed)',
        '\t\x1b[31mmodified:   src/app/App.tsx\x1b[0m',
        '',
        'Untracked files:',
        '\t\x1b[31mnotes.md\x1b[0m',
        '',
      ].join('\r\n');
    }
    if (command === 'colors') {
      const normal = [30, 31, 32, 33, 34, 35, 36, 37].map((c) => `\x1b[${String(c)}m██\x1b[0m`);
      const bright = [90, 91, 92, 93, 94, 95, 96, 97].map((c) => `\x1b[${String(c)}m██\x1b[0m`);
      return `${normal.join(' ')}\r\n${bright.join(' ')}\r\n`;
    }
    return `mock-shell: command not found: ${command.split(' ')[0] ?? command}\r\n`;
  }

  private send(ptyId: number, data: string): void {
    // Timers run in order: output written before an exit is still sent before it.
    setTimeout(() => {
      this.events.output({ ptyId, data });
    }, 0);
  }

  private exit(ptyId: number, exitCode: number | null): void {
    this.ptys.delete(ptyId);
    setTimeout(() => {
      this.events.exited({ ptyId, exitCode });
    }, 0);
  }
}
