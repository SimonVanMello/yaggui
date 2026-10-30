import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend } from '../../ipc/mockClient';
import { useToastStore } from '../../ui/toastStore';
import {
  copyBugReport,
  forwardFrontendError,
  installErrorForwarding,
  MAX_FORWARDED_ERRORS,
  notifyPendingCrashes,
  openLogsFolder,
  reportBug,
  resetForwardedErrors,
} from './diagnostics';

function toasts() {
  return useToastStore.getState().toasts;
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  mockBackend.reset();
  resetForwardedErrors();
  useToastStore.setState({ toasts: [] });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bug report', () => {
  it('copies the report and warns about what it holds', async () => {
    await copyBugReport();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain('### Environment');
    expect(toasts().at(-1)?.title).toBe('Diagnostic report copied');
    expect(toasts().at(-1)?.description).toContain('folder paths');
    expect(mockBackend.issueTrackerOpens).toBe(0);
  });

  it('opens the bug form after copying the report', async () => {
    await reportBug();
    expect(writeText).toHaveBeenCalledOnce();
    expect(mockBackend.issueTrackerOpens).toBe(1);
    expect(toasts().at(-1)?.title).toBe('Diagnostic report copied: paste it into the bug form');
  });

  it('still opens the bug form when the clipboard refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeText.mockRejectedValue(new Error('denied'));
    await reportBug();
    expect(mockBackend.issueTrackerOpens).toBe(1);
    expect(toasts().map((toast) => toast.title)).toEqual([
      'The diagnostic report could not be copied',
    ]);
  });

  it('opens the logs folder', async () => {
    await openLogsFolder();
    expect(mockBackend.logsFolderOpens).toBe(1);
  });
});

describe('notifyPendingCrashes', () => {
  it('says nothing without a crash report', async () => {
    await notifyPendingCrashes();
    expect(toasts()).toEqual([]);
  });

  it('tells once about the latest crash, with a way to report it', async () => {
    mockBackend.pendingCrashes = [
      { file: '/logs/crash-1.txt', at: 1, message: 'first' },
      { file: '/logs/crash-2.txt', at: 2, message: 'index out of bounds' },
    ];
    await notifyPendingCrashes();
    const notice = toasts().at(-1);
    expect(notice?.variant).toBe('warning');
    expect(notice?.title).toBe('yaggui ran into an internal error during an earlier session');
    expect(notice?.description).toBe('index out of bounds');
    expect(notice?.duration).toBe(Infinity);
    expect(mockBackend.pendingCrashes).toEqual([]);

    notice?.action?.onClick();
    await vi.waitFor(() => {
      expect(mockBackend.issueTrackerOpens).toBe(1);
    });
    useToastStore.setState({ toasts: [] });
    await notifyPendingCrashes();
    expect(toasts()).toEqual([]);
  });
});

describe('frontend errors', () => {
  it('forwards each message once, with its stack', () => {
    const error = new TypeError('x is undefined');
    forwardFrontendError('render', error, '\n    at Graph');
    forwardFrontendError('render', error);
    forwardFrontendError('rejection', 'plain reason');
    expect(mockBackend.frontendErrors).toHaveLength(2);
    expect(mockBackend.frontendErrors[0]?.kind).toBe('render');
    expect(mockBackend.frontendErrors[0]?.message).toBe('TypeError: x is undefined');
    expect(mockBackend.frontendErrors[0]?.stack).toContain('at Graph');
    expect(mockBackend.frontendErrors[1]).toEqual({
      kind: 'rejection',
      message: 'plain reason',
      stack: null,
    });
  });

  it('stops after a bounded number of distinct errors', () => {
    for (let n = 0; n < MAX_FORWARDED_ERRORS + 10; n += 1) {
      forwardFrontendError('error', `error ${String(n)}`);
    }
    expect(mockBackend.frontendErrors).toHaveLength(MAX_FORWARDED_ERRORS);
  });

  it('catches the errors nothing else caught', () => {
    const uninstall = installErrorForwarding();
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('boom'), message: 'Uncaught Error: boom' }),
    );
    uninstall();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after uninstall' }));
    expect(mockBackend.frontendErrors.map((entry) => entry.message)).toEqual(['Error: boom']);
  });
});
