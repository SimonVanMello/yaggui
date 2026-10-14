import type { YagguiEventHandler, YagguiEventMap, YagguiEventName, YagguiEvents } from './client';

type Handlers = { [K in YagguiEventName]?: Set<YagguiEventHandler<K>> };

/** In-memory event bus implementing the event half of the contract (mock backend, tests). */
export class EventEmitter implements YagguiEvents {
  private handlers: Handlers = {};

  subscribe<K extends YagguiEventName>(name: K, handler: YagguiEventHandler<K>): () => void {
    const set: Set<YagguiEventHandler<K>> = this.handlers[name] ?? new Set();
    this.handlers[name] = set as Handlers[K];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit<K extends YagguiEventName>(name: K, payload: YagguiEventMap[K]): void {
    const set = this.handlers[name];
    set?.forEach((handler) => {
      handler(payload);
    });
  }

  listenerCount(name: YagguiEventName): number {
    return this.handlers[name]?.size ?? 0;
  }
}
