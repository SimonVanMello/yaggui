import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// A dialog layer that crashes while rendering, like any of the global dialogs could.
vi.mock('../ui/Toaster', () => ({
  Toaster: () => {
    throw new Error('toaster exploded');
  },
}));

const { App } = await import('./App');

describe('App', () => {
  it('shows the crash screen when a global dialog layer fails to render', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('toaster exploded');
  });
});
