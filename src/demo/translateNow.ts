import { translate, useI18nStore, type MessageKey, type MessageParams } from '../i18n/i18n';

export function translateNow(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}
