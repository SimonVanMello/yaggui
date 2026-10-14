import { useQuery } from '@tanstack/react-query';

import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { MenuLabel } from '../../ui/MenuLabel';
import { MenuSeparator } from '../../ui/MenuSeparator';
import styles from './CommitTools.module.css';
import { commitToolsKeys, fillDraft } from './commitToolsOps';
import { openCommitToolsDialog, useCommitTools } from './commitToolsStore';

/** First line of a message, for a menu. */
function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}

/**
 * Message helpers above the summary (F-067, F-068): Conventional Commits fields, templates
 * (`commit.template` and the user's own) and the recent messages of the repository.
 */
export function MessageTools({ repoId }: { repoId: number }) {
  const t = useT();
  const conventional = useCommitTools((s) => s.conventional);
  const setConventional = useCommitTools((s) => s.setConventional);
  const settings = useQuery({
    queryKey: commitToolsKeys.settings(repoId),
    queryFn: () => unwrap(ipc.commands.commitSettings(repoId)),
    staleTime: 30_000,
  });
  const templates = useQuery({
    queryKey: commitToolsKeys.templates(),
    queryFn: () => unwrap(ipc.commands.listCommitTemplates()),
  });
  const recent = useQuery({
    queryKey: commitToolsKeys.recent(repoId),
    queryFn: () => unwrap(ipc.commands.recentCommitMessages(repoId)),
  });
  const gitTemplate = settings.data?.template ?? null;
  const own = templates.data ?? [];
  const messages = recent.data ?? [];

  return (
    <div className={styles.tools}>
      <Button
        size="sm"
        variant="ghost"
        className={styles.toggle}
        aria-pressed={conventional}
        onClick={() => {
          setConventional(!conventional);
        }}
      >
        {t('commit.conventional.toggle')}
      </Button>
      <span className={styles.spacer} />
      <Menu
        align="end"
        trigger={
          <Button size="sm" variant="ghost" aria-label={t('commit.templates.menu')}>
            {t('commit.templates.button')}
            <Icon name="chevronDown" size="sm" />
          </Button>
        }
      >
        {gitTemplate && (
          <>
            <MenuLabel>{t('commit.templates.git')}</MenuLabel>
            <MenuItem
              icon="file"
              hint={settings.data?.templatePath ?? undefined}
              onSelect={() => {
                fillDraft(
                  repoId,
                  gitTemplate.description
                    ? `${gitTemplate.summary}\n\n${gitTemplate.description}`
                    : gitTemplate.summary,
                );
              }}
            >
              <span className={styles.menuMessage}>
                {gitTemplate.summary || t('commit.templates.untitled')}
              </span>
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {settings.data?.templateError && (
          <>
            <MenuLabel>{t('commit.templates.gitError')}</MenuLabel>
            <MenuSeparator />
          </>
        )}
        {own.length > 0 && <MenuLabel>{t('commit.templates.own')}</MenuLabel>}
        {own.map((template) => (
          <MenuItem
            key={template.id ?? template.name}
            onSelect={() => {
              fillDraft(repoId, template.body);
            }}
            hint={firstLine(template.body)}
          >
            {template.name}
          </MenuItem>
        ))}
        {own.length > 0 && <MenuSeparator />}
        <MenuItem
          icon="settings"
          onSelect={() => {
            openCommitToolsDialog({ kind: 'templates', repoId });
          }}
        >
          {t('commit.templates.manage')}
        </MenuItem>
      </Menu>
      <Menu
        align="end"
        trigger={
          <Button size="sm" variant="ghost" aria-label={t('commit.recent.menu')}>
            {t('commit.recent.button')}
            <Icon name="chevronDown" size="sm" />
          </Button>
        }
      >
        {messages.length === 0 ? (
          <MenuItem disabled>{t('commit.recent.empty')}</MenuItem>
        ) : (
          messages.map((message) => (
            <MenuItem
              key={message.message}
              onSelect={() => {
                fillDraft(repoId, message.message);
              }}
              hint={message.message.includes('\n') ? t('commit.recent.withBody') : undefined}
            >
              <span className={styles.menuMessage}>{firstLine(message.message)}</span>
            </MenuItem>
          ))
        )}
      </Menu>
    </div>
  );
}
