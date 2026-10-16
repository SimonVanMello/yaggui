import { useEffect, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { attachTerminal, detachTerminal, fitTerminal } from '../terminal/terminalSessions';
import {
  closeUpgrade,
  restartAfterUpgrade,
  startUpgrade,
  upgradeBusy,
  useUpgradeStore,
  type UpgradePhase,
} from './upgradeStore';
import styles from './UpgradeDialog.module.css';

/** The upgrade of a package-manager copy, run in a terminal (SPEC §10). */
export function UpgradeDialog() {
  const t = useT();
  const update = useUpgradeStore((state) => state.update);
  const terminalId = useUpgradeStore((state) => state.terminalId);
  const phase = useUpgradeStore((state) => state.phase);
  // A state, not a ref: the portal mounts the content after the first commit.
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!terminalId || !screen) return;
    attachTerminal(terminalId, screen);
    const observer = new ResizeObserver(() => {
      fitTerminal(terminalId);
    });
    observer.observe(screen);
    return () => {
      observer.disconnect();
      detachTerminal(terminalId);
    };
  }, [terminalId, screen]);

  if (!update) return null;
  const busy = upgradeBusy(phase);
  const succeeded = phase.kind === 'exited' && phase.exitCode === 0;

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open && !busy) closeUpgrade();
      }}
      // `Esc` belongs to the package manager while it runs.
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      title={t('updates.terminal.title', { version: update.version })}
      description={<PhaseText phase={phase} version={update.version} />}
      footer={
        <>
          <Button
            variant={succeeded ? 'ghost' : 'secondary'}
            disabled={busy}
            onClick={closeUpgrade}
          >
            {t('common.close')}
          </Button>
          {succeeded && (
            <Button variant="primary" autoFocus onClick={restartAfterUpgrade}>
              {t('updates.terminal.restart')}
            </Button>
          )}
          {!busy && !succeeded && (
            <Button
              variant="primary"
              onClick={() => {
                startUpgrade(update);
              }}
            >
              {t('error.action.retry')}
            </Button>
          )}
        </>
      }
    >
      {phase.kind === 'failed' && (
        <ErrorPanel compact title={t('updates.terminal.failed')} error={phase.error} />
      )}
      <div className={styles.body} hidden={phase.kind === 'failed'}>
        <div ref={setScreen} className={styles.screen} />
      </div>
    </Dialog>
  );
}

function PhaseText({ phase, version }: { phase: UpgradePhase; version: string }) {
  const t = useT();
  switch (phase.kind) {
    case 'preparing':
      return phase.percent === null
        ? t('updates.terminal.starting')
        : t('updates.terminal.downloading', { percent: phase.percent });
    case 'running':
      return t('updates.terminal.running');
    case 'exited':
      if (phase.exitCode === 0) return t('updates.terminal.done', { version });
      return phase.exitCode === null
        ? t('updates.terminal.stopped')
        : t('updates.terminal.exitCode', { code: phase.exitCode });
    case 'failed':
      return t('updates.terminal.failed');
  }
}
