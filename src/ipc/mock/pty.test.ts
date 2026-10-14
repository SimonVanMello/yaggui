import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PtyExited, PtyOutput } from '../bindings';
import { MockPtys } from './pty';

const output: PtyOutput[] = [];
const exited: PtyExited[] = [];
const ptys = new MockPtys({
  output: (payload) => output.push(payload),
  exited: (payload) => exited.push(payload),
});

function printed(ptyId: number): string {
  return output
    .filter((o) => o.ptyId === ptyId)
    .map((o) => o.data)
    .join('');
}

beforeEach(() => {
  vi.useFakeTimers();
  ptys.reset();
  output.length = 0;
  exited.length = 0;
});

describe('mock integrated terminal', () => {
  it('echoes input and answers a few commands in the repository folder', () => {
    const info = ptys.spawn(1, '/Users/alex/dev/yaggui', 80, 24);
    if ('code' in info) throw new Error('spawn failed');
    expect(info.shell).toBe('/bin/zsh');
    ptys.write(info.ptyId, 'pwd\r');
    ptys.write(info.ptyId, 'git status\r');
    vi.runAllTimers();
    const text = printed(info.ptyId);
    expect(text).toContain('yaggui');
    expect(text).toContain('/Users/alex/dev/yaggui\r\n');
    expect(text).toContain('On branch');
    expect(ptys.written.get(info.ptyId)).toBe('pwd\rgit status\r');
  });

  it('reports its size and exits', () => {
    const info = ptys.spawn(1, '/r', 80, 24);
    if ('code' in info) throw new Error('spawn failed');
    ptys.resize(info.ptyId, 120, 40);
    ptys.write(info.ptyId, 'stty size\rexit\r');
    vi.runAllTimers();
    expect(printed(info.ptyId)).toContain('40 120');
    expect(exited).toEqual([{ ptyId: info.ptyId, exitCode: 0 }]);
    expect(ptys.write(info.ptyId, 'ls\r')).toMatchObject({ code: 'terminalClosed' });
  });

  it('closes every terminal of a repository', () => {
    ptys.spawn(1, '/a', 80, 24);
    ptys.spawn(1, '/a', 80, 24);
    ptys.spawn(2, '/b', 80, 24);
    ptys.closeRepo(1);
    vi.runAllTimers();
    expect(ptys.count(1)).toBe(0);
    expect(ptys.count(2)).toBe(1);
    expect(exited.map((e) => e.exitCode)).toEqual([null, null]);
  });

  it('can simulate a shell that does not start', () => {
    ptys.available = false;
    expect(ptys.spawn(1, '/a', 80, 24)).toMatchObject({ code: 'shellFailed' });
  });
});
