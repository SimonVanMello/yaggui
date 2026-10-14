import type { EventCallback } from '@tauri-apps/api/event';

import type { commands, events } from './bindings';

/** Every backend command, with the exact signatures of the generated bindings. */
export type YagguiCommands = typeof commands;

type GeneratedEvents = typeof events;

export type YagguiEventName = keyof GeneratedEvents;

/** Payload type of each backend event, derived from the generated bindings. */
export type YagguiEventMap = {
  [K in YagguiEventName]: Parameters<GeneratedEvents[K]['listen']>[0] extends EventCallback<infer P>
    ? P
    : never;
};

export type Unsubscribe = () => void;
export type YagguiEventHandler<K extends YagguiEventName> = (payload: YagguiEventMap[K]) => void;

export interface YagguiEvents {
  /** Synchronously returns an unsubscribe function, even if the underlying listen is async. */
  subscribe<K extends YagguiEventName>(name: K, handler: YagguiEventHandler<K>): Unsubscribe;
}

/**
 * Contract between the frontend and the backend, derived from the generated bindings.
 * Both the Tauri client and the mock client implement it, so a new Rust command or event
 * fails the typecheck until the mock supports it.
 */
export interface YagguiClient {
  commands: YagguiCommands;
  events: YagguiEvents;
}
