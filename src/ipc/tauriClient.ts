import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event';

import { commands, events } from './bindings';
import type { YagguiClient, YagguiEventMap, YagguiEventName, YagguiEvents } from './client';

type Listen<K extends YagguiEventName> = (
  callback: EventCallback<YagguiEventMap[K]>,
) => Promise<UnlistenFn>;

const tauriEvents: YagguiEvents = {
  subscribe(name, handler) {
    // Indexing the generated map with a generic key yields a union TS cannot call; the
    // mapped type `YagguiEventMap` guarantees the payload matches `name`.
    const listen = events[name].listen as unknown as Listen<typeof name>;
    let unlisten: UnlistenFn | undefined;
    let active = true;
    listen((event) => {
      if (active) handler(event.payload);
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error: unknown) => {
        console.warn(`Could not subscribe to the ${name} event`, error);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};

export const tauriClient: YagguiClient = { commands, events: tauriEvents };
