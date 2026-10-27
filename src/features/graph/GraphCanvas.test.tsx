import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { mockBackend } from '../../ipc/mockClient';
import { GraphCanvas } from './GraphCanvas';
import { GraphSource } from './graphSource';
import { ScrollMapper } from './scrollMapper';

const WIDTH = 200;

function Harness({ source, dataVersion }: { source: GraphSource; dataVersion: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef}>
      <GraphCanvas
        source={source}
        mapper={new ScrollMapper()}
        scrollRef={scrollRef}
        rowHeight={28}
        wipHeight={0}
        width={WIDTH}
        viewportHeight={280}
        totalRows={10}
        dataVersion={dataVersion}
      />
    </div>
  );
}

let mediaListeners: EventListenerOrEventListenerObject[] = [];
let ratio = 1;

beforeAll(() => {
  // jsdom draws nothing: the bitmap size is what the test looks at.
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ratio });
  window.matchMedia = (query: string): MediaQueryList => {
    const list = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        mediaListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        mediaListeners = mediaListeners.filter((l) => l !== listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
    return list;
  };
});

afterEach(() => {
  ratio = 1;
  mediaListeners = [];
  mockBackend.reset();
});

describe('GraphCanvas', () => {
  it('redraws its tiles at the new pixel ratio when the window changes monitor', () => {
    const source = new GraphSource(1);
    const { container, rerender } = render(<Harness source={source} dataVersion={0} />);
    // The scroller's ref is attached after the first draw: the next data change draws.
    rerender(<Harness source={source} dataVersion={1} />);
    const drawn = () =>
      [...container.querySelectorAll('canvas')].filter((c) => c.style.visibility === 'visible');
    expect(drawn().length).toBeGreaterThan(0);
    expect(drawn().every((c) => c.width === WIDTH)).toBe(true);
    expect(mediaListeners).toHaveLength(1);

    ratio = 2;
    act(() => {
      const event = new Event('change');
      for (const listener of mediaListeners) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    });
    expect(drawn().every((c) => c.width === WIDTH * 2)).toBe(true);
    // Watching the new ratio now, for the move back.
    expect(mediaListeners).toHaveLength(1);
    source.dispose();
  });
});
