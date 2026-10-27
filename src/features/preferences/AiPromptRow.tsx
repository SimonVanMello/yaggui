import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { AI_PROMPT_MAX, ipc, unwrap } from '../../ipc';
import { saveAi } from '../ai/aiPrefs';
import { aiKeys, useAiSettings } from '../ai/aiQueries';
import { useDraft } from './useDraft';
import styles from './AiTab.module.css';

/**
 * Editor of the instructions given to the model (F-074). `null` in the preferences means "the
 * built-in prompt", so an edit identical to it is saved as `null` and keeps following updates.
 */
export function AiPromptRow() {
  const t = useT();
  const id = useId();
  const { customPrompt } = useAiSettings();
  const fallback = useQuery({
    queryKey: aiKeys.defaultPrompt(),
    queryFn: () => unwrap(ipc.commands.aiDefaultPrompt()),
    staleTime: Infinity,
  });
  const builtIn = fallback.data ?? '';
  const [text, setText] = useDraft(customPrompt ?? builtIn);

  const commit = () => {
    const next = text.trim() === '' || text === builtIn ? null : text;
    if (next !== customPrompt) void saveAi({ customPrompt: next });
    if (next === null) setText(builtIn);
  };

  return (
    <div className={styles.prompt}>
      <div className={styles.promptHeader}>
        <label htmlFor={id} className={styles.promptLabel}>
          {t('prefs.ai.prompt')}
        </label>
        {customPrompt !== null && (
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setText(builtIn);
              void saveAi({ customPrompt: null });
            }}
          >
            {t('prefs.ai.prompt.reset')}
          </button>
        )}
      </div>
      <textarea
        id={id}
        className={styles.promptText}
        rows={9}
        spellCheck={false}
        maxLength={AI_PROMPT_MAX}
        value={text}
        disabled={fallback.data === undefined && customPrompt === null}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={commit}
      />
      <span className={styles.status}>
        {t(customPrompt === null ? 'prefs.ai.prompt.default' : 'prefs.ai.prompt.custom')}
        {customPrompt !== null &&
          ` ${t('prefs.ai.prompt.count', { count: text.length, max: AI_PROMPT_MAX })}`}
      </span>
      <span className={styles.status}>{t('prefs.ai.prompt.hint')}</span>
    </div>
  );
}
