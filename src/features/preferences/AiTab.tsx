import { useId, useState, type ReactNode } from 'react';

import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { usePreferences } from '../../app/usePreferences';
import { useT } from '../../i18n/useT';
import {
  AI_DIFF_BYTES_MAX,
  AI_DIFF_BYTES_MIN,
  AI_FILE_BYTES_MAX,
  AI_FILE_BYTES_MIN,
  AI_RECENT_SUBJECTS_MAX,
  AI_TIMEOUT_MAX,
  AI_TIMEOUT_MIN,
  type AiLanguage,
  type AiProviderStatus,
} from '../../ipc';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { saveAi } from '../ai/aiPrefs';
import { providerDestinationKey } from '../ai/providerCopy';
import { selectedProvider, useAiSettings, useAiStatus } from '../ai/aiQueries';
import { AiApiKeyRows } from './AiApiKeyRows';
import { AiCliRows } from './AiCliRows';
import { AiNumberRow } from './AiNumberRow';
import { AiPreviewDialog } from './AiPreviewDialog';
import { AiPromptRow } from './AiPromptRow';
import { AiTestRow } from './AiTestRow';
import { Row } from './Row';
import { savePreferenceOrToast } from './savePreference';
import { useDraft } from './useDraft';
import styles from './AiTab.module.css';

/**
 * AI commit messages (F-072 to F-075): the master switch with what leaves the machine, the
 * provider and its credentials, the prompt and the limits of the context. Everything applies
 * at once; the feature stays off until the switch is turned on.
 */
export function AiTab() {
  const t = useT();
  const prefs = usePreferences();
  const settings = useAiSettings();
  const status = useAiStatus();
  const [previewOpen, setPreviewOpen] = useState(false);
  const repoId = useTabsStore((state) => selectActiveTab(state).repoId);
  const providers = status.data?.providers ?? [];
  const current = selectedProvider(status.data, settings);

  return (
    <>
      <Switch
        checked={prefs.aiEnabled === true}
        label={t('prefs.ai.enable')}
        hint={t('prefs.ai.enable.hint')}
        onCheckedChange={(aiEnabled) => {
          savePreferenceOrToast({ aiEnabled });
        }}
      />
      <section className={styles.notice} aria-labelledby="ai-sends-title">
        <h3 id="ai-sends-title" className={styles.noticeTitle}>
          {t('prefs.ai.sends.title')}
        </h3>
        <p className={styles.noticeText}>{t('prefs.ai.sends.intro')}</p>
        <ul className={styles.noticeList}>
          <li>{t('prefs.ai.sends.diff')}</li>
          <li>{t('prefs.ai.sends.files')}</li>
          <li>{t('prefs.ai.sends.branch')}</li>
          <li>{t('prefs.ai.sends.subjects')}</li>
        </ul>
        <p className={styles.noticeText}>
          {(() => {
            const key = providerDestinationKey(settings.provider);
            return key
              ? t(key)
              : t('prefs.ai.sends.to.other', { provider: current?.name ?? settings.provider });
          })()}
        </p>
        <div>
          <Button
            onClick={() => {
              setPreviewOpen(true);
            }}
          >
            {t('prefs.ai.preview')}
          </Button>
        </div>
      </section>
      <AiPreviewDialog repoId={repoId} open={previewOpen} onOpenChange={setPreviewOpen} />

      <Group title={t('prefs.ai.group.provider')}>
        <Row label={t('prefs.ai.provider')} hint={t('prefs.ai.provider.hint')}>
          {providers.length > 0 && (
            <SegmentedControl
              label={t('prefs.ai.provider')}
              value={settings.provider}
              options={providers.map((p) => ({ value: p.kind, label: p.name }))}
              onChange={(provider) => {
                void saveAi({ provider });
              }}
            />
          )}
        </Row>
        {current && <ProviderRows provider={current} />}
        {current && <AiTestRow key={current.kind} provider={current} />}
      </Group>

      <Group title={t('prefs.ai.group.prompt')}>
        <AiPromptRow />
      </Group>

      <Group title={t('prefs.ai.group.context')}>
        <AiNumberRow
          label={t('prefs.ai.maxDiff')}
          hint={t('prefs.ai.maxDiff.hint', { min: AI_DIFF_BYTES_MIN, max: AI_DIFF_BYTES_MAX })}
          value={settings.maxDiffBytes}
          min={AI_DIFF_BYTES_MIN}
          max={AI_DIFF_BYTES_MAX}
          onSave={(maxDiffBytes) => {
            void saveAi({ maxDiffBytes });
          }}
        />
        <AiNumberRow
          label={t('prefs.ai.maxFile')}
          hint={t('prefs.ai.maxFile.hint', { min: AI_FILE_BYTES_MIN, max: AI_FILE_BYTES_MAX })}
          value={settings.maxFileBytes}
          min={AI_FILE_BYTES_MIN}
          max={AI_FILE_BYTES_MAX}
          onSave={(maxFileBytes) => {
            void saveAi({ maxFileBytes });
          }}
        />
        <ExcludedPathsRow patterns={settings.excludedPaths} />
        <Switch
          checked={settings.recentSubjects > 0}
          label={t('prefs.ai.subjects')}
          hint={t('prefs.ai.subjects.hint')}
          onCheckedChange={(on) => {
            void saveAi({ recentSubjects: on ? 10 : 0 });
          }}
        />
        {settings.recentSubjects > 0 && (
          <AiNumberRow
            label={t('prefs.ai.subjects.count')}
            hint=""
            value={settings.recentSubjects}
            min={1}
            max={AI_RECENT_SUBJECTS_MAX}
            onSave={(recentSubjects) => {
              void saveAi({ recentSubjects });
            }}
          />
        )}
        <Row label={t('prefs.ai.language')} hint={t('prefs.ai.language.hint')}>
          <SegmentedControl<AiLanguage>
            label={t('prefs.ai.language')}
            value={settings.language}
            options={[
              { value: 'auto', label: t('prefs.ai.language.auto') },
              { value: 'en', label: t('prefs.ai.language.en') },
              { value: 'fr', label: t('prefs.ai.language.fr') },
            ]}
            onChange={(language) => {
              void saveAi({ language });
            }}
          />
        </Row>
        <AiNumberRow
          label={t('prefs.ai.timeout')}
          hint={t('prefs.ai.timeout.hint', { min: AI_TIMEOUT_MIN, max: AI_TIMEOUT_MAX })}
          value={settings.timeoutSeconds}
          min={AI_TIMEOUT_MIN}
          max={AI_TIMEOUT_MAX}
          onSave={(timeoutSeconds) => {
            void saveAi({ timeoutSeconds });
          }}
        />
      </Group>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{title}</legend>
      {children}
    </fieldset>
  );
}

/** The rows that depend on what the provider needs: an API key, or a local program. */
function ProviderRows({ provider }: { provider: AiProviderStatus }) {
  const settings = useAiSettings();
  if (provider.credential.kind === 'apiKey') {
    return <AiApiKeyRows provider={provider} settings={settings} />;
  }
  return <AiCliRows provider={provider} settings={settings} />;
}

/** One glob per line; blank lines and duplicates are dropped by the backend. */
function ExcludedPathsRow({ patterns }: { patterns: string[] }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useDraft(patterns.join('\n'));
  const commit = () => {
    const next = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (next.join('\n') !== patterns.join('\n')) void saveAi({ excludedPaths: next });
  };
  return (
    <div className={styles.prompt}>
      <label htmlFor={id} className={styles.promptLabel}>
        {t('prefs.ai.excluded')}
      </label>
      <textarea
        id={id}
        className={styles.promptText}
        rows={5}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={commit}
      />
      <span className={styles.status}>{t('prefs.ai.excluded.hint')}</span>
    </div>
  );
}
