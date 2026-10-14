import { useT } from '../../i18n/useT';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import { fetchRepo, fetchTags, pushAllTags } from '../network/networkOps';
import { openRemoteDialog } from '../remotes/remoteDialogsStore';
import { removeRemote } from '../remotes/remoteOps';
import { copyText } from './refActions';
import { useRepoRefs } from './useRepoRefs';

/** What a right-click outside a ref row designates. */
export type GroupMenuTarget =
  { kind: 'remote'; name: string } | { kind: 'section'; section: 'remote' | 'tags' };

/** Context menu of a remote folder, or of the Remote and Tags section headers (F-124, F-125). */
export function RemoteContextMenu({ repoId, target }: { repoId: number; target: GroupMenuTarget }) {
  const t = useT();
  const remotes = useRepoRefs(repoId).data?.remotes ?? [];

  if (target.kind === 'remote') {
    const { name } = target;
    const remote = remotes.find((r) => r.name === name);
    return (
      <>
        <ContextMenuItem
          icon="fetch"
          onSelect={() => {
            void fetchRepo(repoId, { remote: name });
          }}
        >
          {t('sidebar.menu.remoteFetch')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="tag"
          onSelect={() => {
            void fetchTags(repoId, name);
          }}
        >
          {t('sidebar.menu.remoteFetchTags')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="push"
          onSelect={() => {
            void pushAllTags(repoId, name);
          }}
        >
          {t('sidebar.menu.remotePushTags')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon="settings"
          onSelect={() => {
            openRemoteDialog({
              kind: 'edit',
              repoId,
              remote: { name, url: remote?.url ?? null, pushUrl: remote?.pushUrl ?? null },
              fromManage: false,
            });
          }}
        >
          {t('sidebar.menu.remoteEdit')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="trash"
          danger
          onSelect={() => {
            void removeRemote(repoId, name);
          }}
        >
          {t('sidebar.menu.remoteRemove')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon="copy"
          onSelect={() => {
            copyText(name, t('sidebar.what.name'));
          }}
        >
          {t('sidebar.menu.copyName')}
        </ContextMenuItem>
        {remote?.url && (
          <ContextMenuItem
            icon="copy"
            onSelect={() => {
              copyText(remote.url ?? '', t('sidebar.what.url'));
            }}
          >
            {t('sidebar.menu.copyUrl')}
          </ContextMenuItem>
        )}
      </>
    );
  }

  const fetchAll = (
    <ContextMenuItem
      icon="tag"
      disabled={remotes.length === 0}
      onSelect={() => {
        void fetchTags(repoId, null);
      }}
    >
      {t('sidebar.menu.fetchAllTags')}
    </ContextMenuItem>
  );

  if (target.section === 'remote') {
    return (
      <>
        <ContextMenuItem
          icon="plus"
          onSelect={() => {
            openRemoteDialog({ kind: 'edit', repoId, remote: null, fromManage: false });
          }}
        >
          {t('sidebar.menu.addRemote')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="settings"
          onSelect={() => {
            openRemoteDialog({ kind: 'manage', repoId });
          }}
        >
          {t('sidebar.menu.manageRemotes')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {fetchAll}
      </>
    );
  }

  return (
    <>
      {fetchAll}
      {remotes.length > 1 ? (
        <ContextMenuSub icon="push" label={t('sidebar.menu.pushAllTagsTo')}>
          {remotes.map((remote) => (
            <ContextMenuItem
              key={remote.name}
              onSelect={() => {
                void pushAllTags(repoId, remote.name);
              }}
            >
              {remote.name}
            </ContextMenuItem>
          ))}
        </ContextMenuSub>
      ) : (
        <ContextMenuItem
          icon="push"
          disabled={remotes.length === 0}
          onSelect={() => {
            void pushAllTags(repoId, remotes[0]?.name ?? null);
          }}
        >
          {t('sidebar.menu.pushAllTags')}
        </ContextMenuItem>
      )}
    </>
  );
}
