import { useQuery } from '@tanstack/react-query';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import { useCommitTools } from '../staging/commitToolsStore';
import { formatBytes } from '../ai/formatBytes';
import styles from './AiTab.module.css';

/** The exact text a generation would send for the active repository, without sending it. */
export function AiPreviewDialog({
  repoId,
  open,
  onOpenChange,
}: {
  repoId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const conventional = useCommitTools((tools) => tools.conventional);
  const preview = useQuery({
    queryKey: ['ai-preview', repoId, conventional],
    queryFn: () =>
      unwrap(ipc.commands.aiPreviewContext(repoId ?? 0, { amend: false, conventional })),
    enabled: open && repoId !== null,
    // The staged changes move under it: always show what would be sent now.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const summary = preview.data?.summary;
  const reduced = [
    { key: 'prefs.ai.preview.cut', names: summary?.truncatedFiles ?? [] },
    {
      key: 'prefs.ai.preview.nameOnly',
      names: [
        ...(summary?.excludedFiles ?? []),
        ...(summary?.binaryFiles ?? []),
        ...(summary?.omittedFiles ?? []),
      ],
    },
  ] as const;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t('prefs.ai.preview.title')}
      description={t('prefs.ai.preview.description')}
      footer={
        <Button
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common.close')}
        </Button>
      }
    >
      {repoId === null && <p className={styles.status}>{t('prefs.ai.preview.noRepo')}</p>}
      {preview.isFetching && <Spinner />}
      {preview.error instanceof YagguiIpcError && (
        <p className={styles.status} role="alert">
          {localize(preview.error.error.message)}
        </p>
      )}
      {summary && (
        <>
          <p className={styles.status}>
            {t('prefs.ai.preview.summary', {
              files: summary.files,
              size: formatBytes(summary.sentBytes),
            })}
          </p>
          {reduced.map(
            ({ key, names }) =>
              names.length > 0 && (
                <p key={key} className={styles.status}>
                  {t(key, { names: names.join(', ') })}
                </p>
              ),
          )}
          <textarea
            className={styles.previewText}
            readOnly
            rows={16}
            spellCheck={false}
            aria-label={t('prefs.ai.preview.title')}
            value={preview.data?.text ?? ''}
          />
        </>
      )}
    </Dialog>
  );
}
