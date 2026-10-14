import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { currentPreferences, subscribePreferences } from '../../app/preferences';
import { translate, useI18nStore } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type YagguiError } from '../../ipc';
import { platform } from '../../ui/platform';
import { matchBinding } from '../keybindings/registry';
import { TERMINAL_ATTRIBUTE, TERMINAL_PASSTHROUGH, TERMINAL_REPO_ATTRIBUTE } from './terminalFocus';
import { repoTerminals, useTerminalStore } from './terminalStore';

const SCROLLBACK = 5000;
const DEFAULT_SIZE = { cols: 80, rows: 24 };

/**
 * An integrated terminal: the emulator and its PTY. It lives outside React so that it
 * survives the repository view being unmounted (tab switch, panel hidden): its element is
 * only moved between the panel and a hidden parking element.
 */
interface Session {
  id: string;
  repoId: number;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  ptyId: number | null;
  /** Keys typed while a write is in flight, sent together next: writes stay in order. */
  input: string;
  writing: boolean;
  /** The shell exited: the screen stays, input is ignored. */
  exited: boolean;
  disposed: boolean;
}

const sessions = new Map<string, Session>();
const byPty = new Map<number, Session>();
let nextId = 1;
let parking: HTMLDivElement | null = null;
let unsubscribeEvents: (() => void) | null = null;
let themeObserver: MutationObserver | null = null;

function locale() {
  return useI18nStore.getState().locale;
}

function cssVar(style: CSSStyleDeclaration, name: string): string | undefined {
  return style.getPropertyValue(name).trim() || undefined;
}

/** The emulator colors, from the `--term-*` tokens of the current theme. */
export function terminalTheme(root: HTMLElement = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  const color = (name: string) => cssVar(style, `--term-${name}`);
  return {
    background: color('bg'),
    foreground: color('fg'),
    cursor: color('cursor'),
    cursorAccent: color('cursor-fg'),
    selectionBackground: color('selection'),
    black: color('black'),
    red: color('red'),
    green: color('green'),
    yellow: color('yellow'),
    blue: color('blue'),
    magenta: color('magenta'),
    cyan: color('cyan'),
    white: color('white'),
    brightBlack: color('bright-black'),
    brightRed: color('bright-red'),
    brightGreen: color('bright-green'),
    brightYellow: color('bright-yellow'),
    brightBlue: color('bright-blue'),
    brightMagenta: color('bright-magenta'),
    brightCyan: color('bright-cyan'),
    brightWhite: color('bright-white'),
  };
}

/** Theme, font and contrast options, re-read whenever the appearance changes. */
function appearanceOptions() {
  const prefs = currentPreferences();
  const root = document.documentElement;
  return {
    theme: terminalTheme(root),
    fontFamily: cssVar(getComputedStyle(root), '--font-code') ?? 'monospace',
    fontSize: prefs.fontSize,
    // Text darker than the WCAG AA ratio is lightened (or darkened) by the emulator.
    minimumContrastRatio: prefs.highContrast ? 4.5 : 1,
  };
}

function applyAppearance(): void {
  const options = appearanceOptions();
  for (const session of sessions.values()) {
    session.term.options.theme = options.theme;
    session.term.options.fontFamily = options.fontFamily;
    session.term.options.fontSize = options.fontSize;
    session.term.options.minimumContrastRatio = options.minimumContrastRatio;
    if (session.opened && session.host.isConnected) fitSession(session);
  }
}

/** Follows theme, contrast and font changes (attributes and inline variables on <html>). */
function watchAppearance(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(applyAppearance);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-contrast', 'data-density', 'style'],
  });
  subscribePreferences(applyAppearance);
}

function parkingElement(): HTMLDivElement {
  if (!parking || !parking.isConnected) {
    parking = document.createElement('div');
    parking.hidden = true;
    parking.dataset.terminalParking = '';
    document.body.append(parking);
  }
  return parking;
}

function listen(): void {
  if (unsubscribeEvents) return;
  const offOutput = ipc.events.subscribe('ptyOutput', ({ ptyId, data }) => {
    byPty.get(ptyId)?.term.write(data);
  });
  const offExited = ipc.events.subscribe('ptyExited', ({ ptyId, exitCode }) => {
    const session = byPty.get(ptyId);
    if (!session) return;
    byPty.delete(ptyId);
    session.ptyId = null;
    session.exited = true;
    session.input = '';
    const message =
      exitCode === null
        ? translate(locale(), 'terminal.exited')
        : translate(locale(), 'terminal.exitedWithCode', { code: exitCode });
    session.term.write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
    useTerminalStore.getState().updateTab(session.repoId, session.id, {
      status: 'exited',
      exitCode,
    });
  });
  unsubscribeEvents = () => {
    offOutput();
    offExited();
  };
}

function isMac(): boolean {
  return platform === 'mac';
}

/** Copy (⌘C, or Ctrl+Shift+C elsewhere: Ctrl+C is the interrupt) and the app's own keys. */
function handleKey(session: Session, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true;
  if (TERMINAL_PASSTHROUGH.some((id) => matchBinding(event, id))) return false;
  const copy = isMac()
    ? event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyC'
    : event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyC';
  if (copy && session.term.hasSelection()) {
    void navigator.clipboard.writeText(session.term.getSelection()).catch((error: unknown) => {
      console.warn('Could not copy the terminal selection', error);
    });
    event.preventDefault();
    return false;
  }
  // Ctrl+Shift+V pastes (the browser's paste event reaches the emulator); ⌘ keys belong to
  // the app on macOS.
  if (!isMac() && event.ctrlKey && event.shiftKey && event.code === 'KeyV') return false;
  return true;
}

function flushInput(session: Session): void {
  if (session.writing || session.ptyId === null || session.input === '') return;
  const ptyId = session.ptyId;
  const data = session.input;
  session.input = '';
  session.writing = true;
  void ipc.commands
    .ptyWrite(ptyId, data)
    .then((result) => {
      if (result.status === 'error') console.warn('Terminal input lost', result.error);
    })
    .finally(() => {
      session.writing = false;
      flushInput(session);
    });
}

function fitSession(session: Session): void {
  const dims = session.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
  const cols = Math.max(2, dims.cols);
  const rows = Math.max(1, dims.rows);
  if (cols !== session.term.cols || rows !== session.term.rows) session.term.resize(cols, rows);
}

async function spawn(session: Session): Promise<void> {
  const { cols, rows } = session.opened
    ? { cols: session.term.cols, rows: session.term.rows }
    : DEFAULT_SIZE;
  try {
    const info = await unwrap(ipc.commands.ptySpawn(session.repoId, cols, rows));
    if (session.disposed) {
      void ipc.commands.ptyClose(info.ptyId);
      return;
    }
    session.ptyId = info.ptyId;
    byPty.set(info.ptyId, session);
    const title =
      info.shell
        .split(/[\\/]/)
        .at(-1)
        ?.replace(/\.exe$/i, '') ?? info.shell;
    useTerminalStore.getState().updateTab(session.repoId, session.id, {
      status: 'running',
      title,
    });
    // The panel may have been resized while the shell started.
    if (session.term.cols !== cols || session.term.rows !== rows) {
      void ipc.commands.ptyResize(info.ptyId, session.term.cols, session.term.rows);
    }
    flushInput(session);
  } catch (failure) {
    if (session.disposed) return;
    useTerminalStore.getState().updateTab(session.repoId, session.id, {
      status: 'failed',
      error: asYagguiError(failure),
    });
  }
}

function asYagguiError(failure: unknown): YagguiError {
  if (failure instanceof YagguiIpcError) return failure.error;
  const message = failure instanceof Error ? failure.message : String(failure);
  return {
    code: 'internal',
    message: { en: message, fr: message },
    action: null,
    detail: null,
    payload: null,
  };
}

function createSession(repoId: number): Session {
  listen();
  watchAppearance();
  const id = `term-${String(nextId++)}`;
  const term = new Terminal({
    ...appearanceOptions(),
    scrollback: SCROLLBACK,
    cursorBlink: true,
    allowProposedApi: false,
    macOptionIsMeta: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'yaggui-terminal-host';
  host.setAttribute(TERMINAL_ATTRIBUTE, id);
  host.setAttribute(TERMINAL_REPO_ATTRIBUTE, String(repoId));
  parkingElement().append(host);
  const session: Session = {
    id,
    repoId,
    term,
    fit,
    host,
    opened: false,
    ptyId: null,
    input: '',
    writing: false,
    exited: false,
    disposed: false,
  };
  term.attachCustomKeyEventHandler((event) => handleKey(session, event));
  term.onData((data) => {
    // Keys typed while the shell starts are sent once it runs.
    if (session.exited || session.disposed) return;
    session.input += data;
    flushInput(session);
  });
  term.onResize(({ cols, rows }) => {
    if (session.ptyId !== null) void ipc.commands.ptyResize(session.ptyId, cols, rows);
  });
  sessions.set(id, session);
  return session;
}

/** Opens a new terminal in the repository and shows it (the panel opens). */
export function newTerminal(repoId: number): string {
  const session = createSession(repoId);
  useTerminalStore.getState().addTab(repoId, {
    id: session.id,
    title: translate(locale(), 'terminal.panel'),
  });
  return session.id;
}

/**
 * Shows a terminal in `container` and gives it the keyboard. The emulator is created on its
 * first display (it needs a visible element to measure the font), then the shell is started
 * at the size it fits.
 */
export function attachTerminal(id: string, container: HTMLElement, focus = true): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.host.parentElement !== container) container.append(session.host);
  if (!session.opened) {
    session.term.open(session.host);
    session.opened = true;
    fitSession(session);
    void spawn(session);
    // A bundled font loading after the first measure changes the cell size.
    void document.fonts.ready.then(() => {
      if (!session.disposed && session.host.isConnected) fitSession(session);
    });
  } else {
    fitSession(session);
  }
  if (focus) session.term.focus();
}

/** Hides a terminal without ending it (panel closed, other repository shown). */
export function detachTerminal(id: string): void {
  const session = sessions.get(id);
  if (session && !session.disposed) parkingElement().append(session.host);
}

/** Refits a shown terminal to its container (panel resized). */
export function fitTerminal(id: string): void {
  const session = sessions.get(id);
  if (session?.opened && session.host.isConnected) fitSession(session);
}

export function focusTerminal(id: string): void {
  sessions.get(id)?.term.focus();
}

function dispose(session: Session): void {
  session.disposed = true;
  sessions.delete(session.id);
  if (session.ptyId !== null) {
    byPty.delete(session.ptyId);
    void ipc.commands.ptyClose(session.ptyId);
  }
  session.term.dispose();
  session.host.remove();
}

/** Ends a terminal: its shell is closed and its tab removed. */
export function closeTerminal(repoId: number, id: string): void {
  const session = sessions.get(id);
  if (session) dispose(session);
  useTerminalStore.getState().removeTab(repoId, id);
}

/** Ends every terminal of a repository (its tab was closed). */
export function disposeRepoTerminals(repoId: number): void {
  for (const session of [...sessions.values()]) if (session.repoId === repoId) dispose(session);
  useTerminalStore.getState().forgetRepo(repoId);
}

/** Opens the panel, with a first terminal if it has none. */
export function showTerminalPanel(repoId: number): void {
  const repo = repoTerminals(repoId);
  if (repo.tabs.length === 0) newTerminal(repoId);
  else useTerminalStore.getState().setOpen(repoId, true);
}

/** Number of live emulators, for tests. */
export function terminalSessionCount(): number {
  return sessions.size;
}

/** Text of the visible screen of a terminal, for tests. */
export function terminalScreenText(id: string): string {
  const session = sessions.get(id);
  if (!session) return '';
  const buffer = session.term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}
