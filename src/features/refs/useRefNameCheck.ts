import { useEffect, useRef, useState } from 'react';

import { YagguiIpcError, ipc, unwrap, type YagguiError, type RefNameKind } from '../../ipc';

export const NAME_CHECK_DELAY_MS = 250;

export type NameCheck =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'valid' }
  | { status: 'invalid'; error: YagguiError };

const IDLE: NameCheck = { status: 'idle' };

function asYagguiError(error: unknown): YagguiError {
  if (error instanceof YagguiIpcError) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal',
    message: { en: message, fr: message },
    action: null,
    detail: null,
    payload: null,
  };
}

/**
 * Live validation of a new branch or tag name (F-100): `validateRefName` runs once typing
 * pauses. A reply for a name that is no longer the current one is dropped. `skip` (e.g. the
 * unchanged name of a rename) keeps the check idle.
 */
export function useRefNameCheck(
  repoId: number,
  kind: RefNameKind,
  name: string,
  skip = false,
): NameCheck {
  return useNameCheck(`${String(repoId)}:${kind}`, name, skip, (value) =>
    unwrap(ipc.commands.validateRefName(repoId, kind, value)),
  );
}

/**
 * Debounced check of a name with `validate`, which rejects with the reason. `scope` names
 * what is validated: a change of scope checks again, a new `validate` alone does not.
 */
export function useNameCheck(
  scope: string,
  name: string,
  skip: boolean,
  validate: (name: string) => Promise<unknown>,
): NameCheck {
  const [check, setCheck] = useState<{ name: string; result: NameCheck }>({
    name: '',
    result: IDLE,
  });
  const validateRef = useRef(validate);
  useEffect(() => {
    validateRef.current = validate;
  });

  useEffect(() => {
    if (skip || name === '') return;
    // Cleanup runs when the name changes: a reply for an older name is dropped.
    let current = true;
    const timer = setTimeout(() => {
      setCheck({ name, result: { status: 'checking' } });
      validateRef.current(name).then(
        () => {
          if (current) setCheck({ name, result: { status: 'valid' } });
        },
        (error: unknown) => {
          if (current)
            setCheck({ name, result: { status: 'invalid', error: asYagguiError(error) } });
        },
      );
    }, NAME_CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [scope, name, skip]);

  if (skip || name === '') return IDLE;
  // The previous verdict is only shown for the name it was made for: typing resets it.
  return check.name === name ? check.result : IDLE;
}
