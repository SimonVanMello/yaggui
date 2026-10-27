import { useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type AiProviderStatus, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { Row } from './Row';
import styles from './AiTab.module.css';

type TestState =
  | { kind: 'running' }
  | { kind: 'ok'; seconds: string; model: string | null }
  | { kind: 'failed'; error: YagguiError };

/** Sends the provider a tiny prompt with the saved settings and says what came back. */
export function AiTestRow({ provider }: { provider: AiProviderStatus }) {
  const t = useT();
  const [state, setState] = useState<TestState | null>(null);
  const test = async () => {
    setState({ kind: 'running' });
    try {
      const result = await unwrap(ipc.commands.aiTestProvider(provider.kind));
      setState({
        kind: 'ok',
        seconds: (result.durationMs / 1000).toFixed(1),
        model: result.model,
      });
    } catch (failure) {
      if (failure instanceof YagguiIpcError) setState({ kind: 'failed', error: failure.error });
      else throw failure;
    }
  };
  return (
    <Row label={t('prefs.ai.test')} hint={t('prefs.ai.test.hint')}>
      <Button
        disabled={state?.kind === 'running'}
        onClick={() => {
          void test();
        }}
      >
        {state?.kind === 'running' ? (
          <>
            <Spinner />
            {t('prefs.ai.test.running')}
          </>
        ) : (
          t('prefs.ai.test')
        )}
      </Button>
      <span className={styles.result} role="status" data-kind={state?.kind}>
        {state?.kind === 'ok' && (
          <>
            <Icon name="check" className={styles.ok} />
            {state.model
              ? t('prefs.ai.test.okModel', {
                  provider: provider.name,
                  seconds: state.seconds,
                  model: state.model,
                })
              : t('prefs.ai.test.ok', { provider: provider.name, seconds: state.seconds })}
          </>
        )}
        {state?.kind === 'failed' && (
          <>
            <Icon name="error" className={styles.error} />
            <span>
              {localize(state.error.message)}
              {state.error.detail && <code className={styles.detail}>{state.error.detail}</code>}
            </span>
          </>
        )}
      </span>
    </Row>
  );
}
