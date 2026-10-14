import { useShortcut } from '../keybindings/registry';
import { useQuery } from '@tanstack/react-query';

import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type PullStrategy, type RepoState } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { MenuLabel } from '../../ui/MenuLabel';
import { MenuSeparator } from '../../ui/MenuSeparator';
import { fetchRepo, forcePushRepo, pullRepo, pushRepo } from '../network/networkOps';
import styles from './Toolbar.module.css';
import { ToolbarButton } from './ToolbarButton';

const STRATEGIES: PullStrategy[] = ['ffOnly', 'merge', 'rebase'];

/** Pull, Push and Fetch, each with a menu of variants (F-120 to F-123). */
export function NetworkButtons({ repoId, state }: { repoId: number; state: RepoState }) {
  const t = useT();
  const pullShortcut = useShortcut('git.pull');
  const pushShortcut = useShortcut('git.push');
  const fetchShortcut = useShortcut('git.fetch');
  const detached = state.head.kind !== 'branch';
  const { autoFetch, autoFetchMinutes, pullStrategy } = usePreferences();
  const strategy = useQuery({
    // The preference overrides the Git config: a change must refetch the default.
    queryKey: ['pullDefaultStrategy', repoId, pullStrategy],
    queryFn: () => unwrap(ipc.commands.pullDefaultStrategy(repoId)),
  });
  const remotes = useQuery({
    queryKey: ['remotes', repoId],
    queryFn: () => unwrap(ipc.commands.listRemotes(repoId)),
  });

  return (
    <>
      <span className={styles.split}>
        <ToolbarButton
          icon="pull"
          label={t('toolbar.pull')}
          description={
            strategy.data
              ? t('network.pull.tooltip', { strategy: t(`network.strategy.${strategy.data}`) })
              : undefined
          }
          command="git pull"
          shortcut={pullShortcut}
          count={state.upstream?.behind}
          disabled={detached}
          onClick={() => {
            void pullRepo(repoId, null);
          }}
        />
        <Menu
          trigger={
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('network.pull.menu')}
              className={styles.chevron}
            />
          }
        >
          <MenuLabel>{t('network.pull.strategy')}</MenuLabel>
          {STRATEGIES.map((s) => (
            <MenuItem
              key={s}
              disabled={detached}
              hint={s === strategy.data ? t('network.strategy.default') : undefined}
              onSelect={() => {
                void pullRepo(repoId, s);
              }}
            >
              {t(`network.pull.with.${s}`)}
            </MenuItem>
          ))}
        </Menu>
      </span>
      <span className={styles.split}>
        <ToolbarButton
          icon="push"
          label={t('toolbar.push')}
          command="git push"
          shortcut={pushShortcut}
          count={state.upstream?.ahead}
          disabled={detached}
          onClick={() => {
            void pushRepo(repoId);
          }}
        />
        <Menu
          trigger={
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('network.push.menu')}
              className={styles.chevron}
            />
          }
        >
          <MenuItem
            icon="push"
            disabled={detached}
            onSelect={() => {
              void pushRepo(repoId);
            }}
          >
            {t('toolbar.push')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            disabled={detached || state.upstream === null}
            hint="--force-with-lease"
            onSelect={() => {
              void forcePushRepo(repoId);
            }}
          >
            {t('network.force.menu')}
          </MenuItem>
        </Menu>
      </span>
      <span className={styles.split}>
        <ToolbarButton
          icon="fetch"
          label={t('toolbar.fetch')}
          command="git fetch --all --prune"
          shortcut={fetchShortcut}
          onClick={() => {
            void fetchRepo(repoId);
          }}
        />
        <Menu
          trigger={
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('network.fetch.menu')}
              className={styles.chevron}
            />
          }
        >
          <MenuItem
            icon="fetch"
            hint="--all --prune"
            onSelect={() => {
              void fetchRepo(repoId);
            }}
          >
            {t('network.fetch.all')}
          </MenuItem>
          {(remotes.data ?? []).map((remote) => (
            <MenuItem
              key={remote}
              onSelect={() => {
                void fetchRepo(repoId, { remote });
              }}
            >
              {t('network.fetch.remote', { remote })}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>
            {autoFetch
              ? t('network.fetch.auto', { minutes: autoFetchMinutes })
              : t('network.fetch.autoOff')}
          </MenuLabel>
        </Menu>
      </span>
    </>
  );
}
