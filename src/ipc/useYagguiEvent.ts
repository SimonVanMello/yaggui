import { useEffect, useRef } from 'react';

import type { YagguiEventHandler, YagguiEventName } from './client';
import { ipc } from './index';

/**
 * Subscribes to a backend event for the lifetime of the component. The latest `handler`
 * is always called, without resubscribing on every render.
 */
export function useYagguiEvent<K extends YagguiEventName>(
  name: K,
  handler: YagguiEventHandler<K>,
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(
    () =>
      ipc.events.subscribe(name, (payload) => {
        handlerRef.current(payload);
      }),
    [name],
  );
}
