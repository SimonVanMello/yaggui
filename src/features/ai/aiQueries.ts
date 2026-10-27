import { useQuery } from '@tanstack/react-query';

import { usePreferences } from '../../app/usePreferences';
import { DEFAULT_AI_PREFERENCES, ipc, unwrap } from '../../ipc';
import type { AiPreferences, AiProviderStatus, AiStatus } from '../../ipc';

export const aiKeys = {
  status: () => ['ai-status'] as const,
  skills: (repoId: number | null) => ['ai-skills', repoId] as const,
  defaultPrompt: () => ['ai-default-prompt'] as const,
};

/** Providers with what they need and what the backend found; refetched after a change. */
export function useAiStatus(enabled = true) {
  return useQuery({
    queryKey: aiKeys.status(),
    queryFn: () => unwrap(ipc.commands.aiStatus()),
    staleTime: 10_000,
    enabled,
  });
}

export function useAiSettings(): AiPreferences {
  return usePreferences().ai ?? DEFAULT_AI_PREFERENCES;
}

/** The provider the commit area uses, as the backend describes it (`null` until it answered). */
export function selectedProvider(
  status: AiStatus | undefined,
  settings: AiPreferences,
): AiProviderStatus | null {
  return status?.providers.find((p) => p.kind === settings.provider) ?? null;
}

export interface AiAvailability {
  /** The feature is turned on in the preferences. */
  enabled: boolean;
  /** The chosen provider has what it needs (key, program); `false` until known. */
  ready: boolean;
}

export function useAiAvailability(): AiAvailability {
  const enabled = usePreferences().aiEnabled === true;
  const settings = useAiSettings();
  // Nothing is asked of the backend while the feature is off.
  const status = useAiStatus(enabled);
  return { enabled, ready: selectedProvider(status.data, settings)?.ready === true };
}
