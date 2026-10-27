import { currentPreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { DEFAULT_AI_PREFERENCES, type AiPreferences, type Preferences } from '../../ipc';
import { savePreference } from '../preferences/savePreference';
import { aiKeys } from './aiQueries';

/**
 * Saves a change of the AI settings on top of the current ones, then asks the backend what the
 * providers need again: the key, the program path or the provider may have changed what is ready.
 */
export async function saveAi(patch: Partial<AiPreferences>): Promise<void> {
  const current = currentPreferences().ai ?? DEFAULT_AI_PREFERENCES;
  await saveAiPreferences({ ai: { ...current, ...patch } });
}

export async function saveAiPreferences(patch: Partial<Preferences>): Promise<void> {
  if (await savePreference(patch)) {
    void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
  }
}
