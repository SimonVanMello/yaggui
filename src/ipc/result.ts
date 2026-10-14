import type { YagguiError } from './bindings';

export type IpcResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: YagguiError };

/** Thrown by `unwrap`, so TanStack Query and error boundaries get the typed backend error. */
export class YagguiIpcError extends Error {
  readonly error: YagguiError;

  constructor(error: YagguiError) {
    super(error.message.en);
    this.name = 'YagguiIpcError';
    this.error = error;
  }
}

/** Turns a command result into its data, or throws a `YagguiIpcError`. */
export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const value = await result;
  if (value.status === 'error') throw new YagguiIpcError(value.error);
  return value.data;
}
