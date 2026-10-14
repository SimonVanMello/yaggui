import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
  it('renders a non-submitting button with the variant class', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Commit
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Commit' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button.className).toContain('primary');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Push
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
