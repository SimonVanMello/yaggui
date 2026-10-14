import { useQuery } from '@tanstack/react-query';

import { useT } from '../../i18n/useT';
import { ipc, unwrap, type SigningFormat } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { MenuLabel } from '../../ui/MenuLabel';
import { MenuSeparator } from '../../ui/MenuSeparator';
import { Tooltip } from '../../ui/Tooltip';
import styles from './CommitTools.module.css';
import { applyProfile, commitToolsKeys } from './commitToolsOps';
import { openCommitToolsDialog } from './commitToolsStore';

const FORMAT_LABEL: Record<SigningFormat, string> = { openpgp: 'GPG', ssh: 'SSH', x509: 'X.509' };

/**
 * Who the next commit is from, with the identity profiles to apply to this repository
 * (F-070), and whether Git will sign it (F-066).
 */
export function CommitIdentity({ repoId }: { repoId: number }) {
  const t = useT();
  const identity = useQuery({
    queryKey: commitToolsKeys.identity(repoId),
    queryFn: () => unwrap(ipc.commands.gitIdentity(repoId)),
  });
  const profiles = useQuery({
    queryKey: commitToolsKeys.profiles(),
    queryFn: () => unwrap(ipc.commands.listIdentityProfiles()),
  });
  const settings = useQuery({
    queryKey: commitToolsKeys.settings(repoId),
    queryFn: () => unwrap(ipc.commands.commitSettings(repoId)),
    staleTime: 30_000,
  });
  const name = identity.data?.name ?? null;
  const email = identity.data?.email ?? null;
  const sign = settings.data?.sign ?? null;
  const current = (profiles.data ?? []).find((p) => p.name === name && p.email === email);

  return (
    <div className={styles.identity}>
      <Menu
        trigger={
          <button type="button" className={styles.who} aria-label={t('identity.picker.label')}>
            <span className={styles.whoText}>
              {name && email
                ? t('identity.picker.as', { name, email })
                : t('identity.picker.unknown')}
            </span>
            {current && <span className={styles.chip}>{current.label}</span>}
            <Icon name="chevronDown" size="sm" />
          </button>
        }
      >
        <MenuLabel>{t('identity.picker.apply')}</MenuLabel>
        {(profiles.data ?? []).map((profile) => (
          <MenuItem
            key={profile.id ?? profile.label}
            icon={profile === current ? 'check' : undefined}
            hint={`${profile.name} <${profile.email}>`}
            onSelect={() => {
              void applyProfile(repoId, profile);
            }}
          >
            {profile.label}
          </MenuItem>
        ))}
        {(profiles.data ?? []).length === 0 && (
          <MenuItem disabled>{t('identity.picker.none')}</MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon="settings"
          onSelect={() => {
            openCommitToolsDialog({ kind: 'profiles', repoId });
          }}
        >
          {t('identity.picker.manage')}
        </MenuItem>
      </Menu>
      {sign && (
        <Tooltip
          content={
            settings.data?.signingKey
              ? t('commit.signing.tooltipKey', { key: settings.data.signingKey })
              : t('commit.signing.tooltip')
          }
        >
          <span className={styles.chip} data-tone="success" tabIndex={0}>
            <Icon name="lock" size="sm" />
            {t('commit.signing.chip', { format: FORMAT_LABEL[sign] })}
          </span>
        </Tooltip>
      )}
    </div>
  );
}
