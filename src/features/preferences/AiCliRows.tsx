import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';

import { currentPreferences } from '../../app/preferences';
import { usePreferences } from '../../app/usePreferences';
import { useTabsStore, selectActiveTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type AiPreferences, type AiProviderStatus, type AiSkill } from '../../ipc';
import { TextInput } from '../../ui/TextInput';
import { saveAi, saveAiPreferences } from '../ai/aiPrefs';
import { aiKeys } from '../ai/aiQueries';
import { Row } from './Row';
import { useDraft } from './useDraft';
import styles from './AiTab.module.css';

/** Program, model and skill of a provider that runs a local command-line tool. */
export function AiCliRows({
  provider,
  settings,
}: {
  provider: AiProviderStatus;
  settings: AiPreferences;
}) {
  const t = useT();
  const binaryId = useId();
  const modelId = useId();
  const modelListId = useId();
  const skillId = useId();
  const skillListId = useId();
  const claudePath = usePreferences().claudePath ?? null;
  const [binary, setBinary] = useDraft(claudePath ?? '');
  const [model, setModel] = useDraft(settings.claudeCode.model ?? '');
  const [skill, setSkill] = useDraft(settings.claudeCode.skill ?? '');
  const repoId = useTabsStore((state) => selectActiveTab(state).repoId);
  const skills = useQuery({
    queryKey: aiKeys.skills(repoId),
    queryFn: () => unwrap(ipc.commands.aiListSkills(repoId)),
    enabled: provider.supportsSkills,
    staleTime: 30_000,
  });
  const credential = provider.credential;
  if (credential.kind !== 'cli') return null;

  const commitBinary = () => {
    const next = binary.trim() || null;
    if (next !== (currentPreferences().claudePath ?? null)) {
      void saveAiPreferences({ claudePath: next });
    }
  };
  const commitModel = () => {
    const next = model.trim() || null;
    if (next !== settings.claudeCode.model) {
      void saveAi({ claudeCode: { ...settings.claudeCode, model: next } });
    }
  };
  const commitSkill = () => {
    const next = skill.trim() || null;
    if (next !== settings.claudeCode.skill) {
      void saveAi({ claudeCode: { ...settings.claudeCode, skill: next } });
    }
  };
  const onEnter = (commit: () => void) => (event: { key: string; preventDefault: () => void }) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  };

  const version = credential.version;
  const binaryStatus = credential.path
    ? credential.configured
      ? version
        ? t('prefs.ai.binary.configured', { path: credential.path, version })
        : t('prefs.ai.binary.configuredNoVersion', { path: credential.path })
      : version
        ? t('prefs.ai.binary.found', { path: credential.path, version })
        : t('prefs.ai.binary.foundNoVersion', { path: credential.path })
    : t('prefs.ai.binary.notFound');
  const known: AiSkill | undefined = skills.data?.find((s) => s.name === skill.trim());

  return (
    <>
      <Row label={t('prefs.ai.binary')} hint={binaryStatus} htmlFor={binaryId}>
        <TextInput
          id={binaryId}
          mono
          value={binary}
          placeholder={t('prefs.ai.binary.placeholder')}
          onChange={(event) => {
            setBinary(event.target.value);
          }}
          onBlur={commitBinary}
          onKeyDown={onEnter(commitBinary)}
        />
      </Row>
      <Row label={t('prefs.ai.model')} hint={t('prefs.ai.model.hintCli')} htmlFor={modelId}>
        <TextInput
          id={modelId}
          mono
          list={modelListId}
          value={model}
          placeholder={t('prefs.ai.model.cliPlaceholder')}
          onChange={(event) => {
            setModel(event.target.value);
          }}
          onBlur={commitModel}
          onKeyDown={onEnter(commitModel)}
        />
        <datalist id={modelListId}>
          {provider.suggestedModels.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Row>
      {provider.supportsSkills && (
        <Row label={t('prefs.ai.skill')} hint={t('prefs.ai.skill.hint')} htmlFor={skillId}>
          <TextInput
            id={skillId}
            mono
            list={skillListId}
            value={skill}
            placeholder={t('prefs.ai.skill.placeholder')}
            onChange={(event) => {
              setSkill(event.target.value);
            }}
            onBlur={commitSkill}
            onKeyDown={onEnter(commitSkill)}
          />
          <datalist id={skillListId}>
            {(skills.data ?? []).map((s) => (
              <option key={s.name} value={s.name} label={skillLabel(s, t)} />
            ))}
          </datalist>
          {known && (
            <span className={styles.status}>
              {[skillLabel(known, t), known.description].filter(Boolean).join(' · ')}
            </span>
          )}
        </Row>
      )}
    </>
  );
}

function skillLabel(skill: AiSkill, t: ReturnType<typeof useT>): string {
  const scope = t(`prefs.ai.skill.scope.${skill.scope}`);
  return skill.legacyCommand ? `${scope} · ${t('prefs.ai.skill.legacy')}` : scope;
}
