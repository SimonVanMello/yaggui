import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { savePreferences } from '../../app/preferences';
import { mockBackend } from '../../ipc/mockClient';
import { Avatar } from './Avatar';
import { clearGravatarCache, gravatarHash, resetGravatar } from './gravatar';

beforeEach(() => {
  mockBackend.reset();
  resetGravatar();
});

afterEach(() => {
  savePreferences({ gravatar: false });
});

/** The mock has a picture unless the first 16 bits of the hash are a multiple of 3. */
async function addressWithPicture(withPicture: boolean): Promise<string> {
  for (let n = 0; n < 50; n += 1) {
    const email = `user${String(n)}@example.com`;
    const hash = await gravatarHash(email);
    if ((parseInt(hash.slice(0, 4), 16) % 3 !== 0) === withPicture) return email;
  }
  throw new Error('no suitable address');
}

describe('gravatar', () => {
  it('hashes the normalized e-mail with SHA-256', async () => {
    const hash = await gravatarHash(' Test@Example.com ');
    expect(hash).toBe('973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
    expect(await gravatarHash('test@example.com')).toBe(hash);
  });

  it('asks the backend for nothing while the preference is off', async () => {
    const { container } = render(<Avatar name="Ada Lovelace" email="ada@example.com" />);
    await act(async () => {
      await gravatarHash('someone-else@example.com');
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('AL');
    expect(mockBackend.avatarRequests).toEqual([]);
  });

  it('shows the picture over the initials once enabled, sending only the hash', async () => {
    const email = await addressWithPicture(true);
    savePreferences({ gravatar: true });
    const { container } = render(<Avatar name="Ada Lovelace" email={email} />);
    await waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\//);
    expect(container.textContent).toBe('AL');
    expect(mockBackend.avatarRequests).toEqual([await gravatarHash(email)]);
  });

  it('keeps the initials when the address has no Gravatar', async () => {
    const email = await addressWithPicture(false);
    savePreferences({ gravatar: true });
    const { container } = render(<Avatar name="Ada Lovelace" email={email} />);
    await waitFor(() => {
      expect(mockBackend.avatarRequests).toHaveLength(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('asks once per address, however many rows show it', async () => {
    const email = await addressWithPicture(true);
    savePreferences({ gravatar: true });
    const { container } = render(
      <>
        <Avatar name="A" email={email} />
        <Avatar name="A" email={email.toUpperCase()} />
        <Avatar name="A" email={email} />
      </>,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(3);
    });
    expect(mockBackend.avatarRequests).toHaveLength(1);
  });

  it('empties the backend cache and asks again afterwards', async () => {
    const email = await addressWithPicture(true);
    savePreferences({ gravatar: true });
    const { container } = render(<Avatar name="A" email={email} />);
    await waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });
    let removed = 0;
    await act(async () => {
      removed = await clearGravatarCache();
    });
    expect(removed).toBe(1);
    await waitFor(() => {
      expect(mockBackend.avatarRequests).toHaveLength(2);
    });
    await waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });
  });
});
