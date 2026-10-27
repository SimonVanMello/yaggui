import { useId, useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type AiPreferences, type AiProviderStatus } from '../../ipc';
import { Button } from '../../ui/Button';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { queryClient } from '../../app/queryClient';
import { aiKeys } from '../ai/aiQueries';
import { saveAi } from '../ai/aiPrefs';
import { Row } from './Row';
import { useDraft } from './useDraft';
import styles from './AiTab.module.css';

/** Key and model of an API provider. The key is write-only: only its source is ever shown. */
export function AiApiKeyRows({
  provider,
  settings,
}: {
  provider: AiProviderStatus;
  settings: AiPreferences;
}) {
  const t = useT();
  const keyId = useId();
  const modelId = useId();
  const listId = useId();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useDraft(settings.claudeApi.model);
  const credential = provider.credential;
  if (credential.kind !== 'apiKey') return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: aiKeys.status() });
  const save = async () => {
    setBusy(true);
    try {
      await unwrap(ipc.commands.aiSetApiKey(provider.kind, key.trim()));
      setKey('');
      toast({ variant: 'success', title: t('prefs.ai.key.saved'), duration: 3000 });
      await refresh();
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await unwrap(ipc.commands.aiClearApiKey(provider.kind));
      toast({ variant: 'success', title: t('prefs.ai.key.removed'), duration: 3000 });
      await refresh();
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(false);
    }
  };
  const commitModel = () => {
    const next = model.trim();
    if (next === '') setModel(settings.claudeApi.model);
    else if (next !== settings.claudeApi.model) void saveAi({ claudeApi: { model: next } });
  };

  const source = credential.source;
  return (
    <>
      <Row label={t('prefs.ai.key')} hint={t('prefs.ai.key.hint')} htmlFor={keyId}>
        <TextInput
          id={keyId}
          mono
          type="password"
          value={key}
          placeholder={t('prefs.ai.key.placeholder')}
          disabled={!credential.keychainAvailable}
          onChange={(event) => {
            setKey(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && key.trim() !== '' && !busy) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <Button
          variant="primary"
          disabled={busy || key.trim() === '' || !credential.keychainAvailable}
          onClick={() => {
            void save();
          }}
        >
          {t('prefs.ai.key.save')}
        </Button>
        {source === 'keychain' && (
          <Button
            disabled={busy}
            onClick={() => {
              void remove();
            }}
          >
            {t('prefs.ai.key.remove')}
          </Button>
        )}
        <span className={styles.status} role="status" data-source={source}>
          {t(`prefs.ai.key.status.${source}`, { envVar: credential.envVar })}
        </span>
        {!credential.keychainAvailable && (
          <span className={styles.status}>
            {t('prefs.ai.key.noKeychain', { envVar: credential.envVar })}
          </span>
        )}
      </Row>
      <Row
        label={t('prefs.ai.model')}
        hint={t('prefs.ai.model.hintApi', { model: provider.defaultModel ?? '' })}
        htmlFor={modelId}
      >
        <TextInput
          id={modelId}
          mono
          list={listId}
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
          }}
          onBlur={commitModel}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitModel();
            }
          }}
        />
        <datalist id={listId}>
          {provider.suggestedModels.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Row>
    </>
  );
}
