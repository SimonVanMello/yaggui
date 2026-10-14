import { useId, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { ConfigScope } from '../../ipc';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { activeRepoId, repoDisplayName, useRepoSessions } from '../repo/repoSessions';
import { COMMON_FIELDS, configValues, multiValuedKeys, normalizeConfigKey } from './gitConfigLogic';
import { ConfigFieldRow } from './ConfigFieldRow';
import { RawConfigEditor } from './RawConfigEditor';
import { useConfigEntries, useConfigWriter } from './useGitConfig';
import styles from './GitConfigTab.module.css';

/** Git configuration editor (F-325): the common keys, then every entry of the file. */
export function GitConfigTab() {
  const t = useT();
  const repoId = activeRepoId();
  const session = useRepoSessions((state) =>
    repoId === null ? undefined : state.sessions[repoId],
  );
  const [scope, setScope] = useState<ConfigScope>('global');
  // Without a repository only the global file can be edited.
  const effectiveScope: ConfigScope = repoId === null ? 'global' : scope;
  const entries = useConfigEntries(effectiveScope, repoId);
  const global = useConfigEntries('global', repoId);
  const write = useConfigWriter(effectiveScope, repoId);
  const headingId = useId();

  const values = configValues(entries.data ?? []);
  const inherited = effectiveScope === 'repo' ? configValues(global.data ?? []) : null;
  const multiple = multiValuedKeys(entries.data ?? []);

  return (
    <>
      <div className={styles.scope}>
        <SegmentedControl<ConfigScope>
          label={t('gitconfig.scope')}
          value={effectiveScope}
          options={[
            { value: 'global', label: t('gitconfig.scope.global') },
            ...(repoId === null
              ? []
              : [{ value: 'repo' as const, label: t('gitconfig.scope.repo') }]),
          ]}
          onChange={setScope}
        />
        <p className={styles.hint}>
          {effectiveScope === 'global'
            ? t('gitconfig.global.hint')
            : t('gitconfig.repo.hint', { repo: repoDisplayName(session, undefined) ?? '' })}
        </p>
      </div>
      {entries.isError && (
        <p className={styles.error} role="alert">
          {t('gitconfig.loadFailed')}
        </p>
      )}
      <section aria-labelledby={headingId} className={styles.fields}>
        <h3 id={headingId} className={styles.heading}>
          {t('gitconfig.common')}
        </h3>
        {COMMON_FIELDS.map((field) => {
          const id = normalizeConfigKey(field.key);
          return (
            <ConfigFieldRow
              // Remounted when the file's value arrives or changes: the draft restarts from it.
              key={`${effectiveScope}:${field.key}:${values.get(id) ?? ''}:${String(entries.data === undefined)}`}
              field={field}
              value={values.get(id) ?? null}
              inheritedValue={inherited?.get(id) ?? null}
              readOnly={multiple.has(id) || entries.data === undefined}
              onCommit={(value) => write(field.key, value)}
            />
          );
        })}
      </section>
      <RawConfigEditor
        entries={entries.data ?? []}
        multiple={multiple}
        onWrite={write}
        scope={effectiveScope}
      />
    </>
  );
}
