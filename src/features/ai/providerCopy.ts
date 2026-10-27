import type { MessageKey } from '../../i18n/i18n';
import type { AiProviderKind } from '../../ipc';

/**
 * Where each provider sends the context, as the preferences say it. A provider added later
 * (Codex…) needs no entry: the screen falls back to a generic sentence naming it.
 */
const DESTINATION: Partial<Record<AiProviderKind, MessageKey>> = {
  claudeApi: 'prefs.ai.sends.to.claudeApi',
  claudeCode: 'prefs.ai.sends.to.claudeCode',
};

export function providerDestinationKey(kind: AiProviderKind): MessageKey | null {
  return DESTINATION[kind] ?? null;
}
