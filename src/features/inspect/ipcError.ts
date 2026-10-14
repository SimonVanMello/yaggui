import { YagguiIpcError, type YagguiError } from '../../ipc';

/** The typed error of a failed query (an unexpected exception becomes `internal`). */
export function errorOf(error: Error): YagguiError {
  return error instanceof YagguiIpcError
    ? error.error
    : {
        code: 'internal',
        message: { en: error.message, fr: error.message },
        action: null,
        detail: null,
        payload: null,
      };
}
