import { describe, expect, it } from 'vitest';

import { mockDocsUrl } from './docs';

describe('mockDocsUrl', () => {
  it('builds the address of each locale, like docs_url', () => {
    expect(mockDocsUrl('', 'en')).toBe('https://yaggui.tropico.dev/docs/');
    expect(mockDocsUrl('start-here/install', 'fr')).toBe(
      'https://yaggui.tropico.dev/fr/docs/start-here/install/',
    );
    expect(mockDocsUrl('/start-here/install/#requirements', 'en')).toBe(
      'https://yaggui.tropico.dev/docs/start-here/install/#requirements',
    );
  });

  it('refuses anything but a docs path', () => {
    for (const page of ['../etc', 'a//b', 'https://example.com', 'Start', 'a b', 'x#a b']) {
      expect(mockDocsUrl(page, 'en')).toBeNull();
    }
  });
});
