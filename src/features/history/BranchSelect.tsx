import { useId } from 'react';

import { useT } from '../../i18n/useT';
import type { RepoRefs } from '../../ipc';
import styles from './HistoryDialogs.module.css';

export interface BranchOption {
  name: string;
  remote: boolean;
}

/** Local branches, then remote ones, minus `exclude`. */
export function branchOptions(
  refs: RepoRefs | undefined,
  exclude: readonly (string | null)[],
  includeRemote: boolean,
): BranchOption[] {
  if (!refs) return [];
  const skip = new Set(exclude);
  const options: BranchOption[] = refs.local
    .filter((branch) => !skip.has(branch.name))
    .map((branch) => ({ name: branch.name, remote: false }));
  if (includeRemote) {
    for (const remote of refs.remotes) {
      for (const branch of remote.branches) {
        if (!skip.has(branch.name)) options.push({ name: branch.name, remote: true });
      }
    }
  }
  return options;
}

/** Labelled native select of branches: keyboard and screen reader behaviour for free. */
export function BranchSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly BranchOption[];
  onChange: (name: string) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="" disabled>
          {t('history.pickBranch')}
        </option>
        <optgroup label={t('sidebar.local')}>
          {options
            .filter((option) => !option.remote)
            .map((option) => (
              <option key={option.name} value={option.name}>
                {option.name}
              </option>
            ))}
        </optgroup>
        {options.some((option) => option.remote) && (
          <optgroup label={t('sidebar.remote')}>
            {options
              .filter((option) => option.remote)
              .map((option) => (
                <option key={option.name} value={option.name}>
                  {option.name}
                </option>
              ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
