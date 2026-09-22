import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ConfirmDialog } from '@/ui/components/primitives';

/** Harness so the dialog opens from a real button (focus-return target). */
function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open && (
        <ConfirmDialog
          label="Confirm test action"
          confirmLabel="Yes, do it"
          danger
          onConfirm={() => {
            onConfirm();
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        >
          <p className="text-sm">Are you sure?</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

describe('QA-02 accessible confirm dialog', () => {
  it('traps focus, Escape cancels, focus returns to opener', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm test action' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Escape cancels without confirming and restores focus to the opener.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open dialog' })).toHaveFocus();
  });

  it('Tab cycles inside the dialog; confirm closes and returns focus', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const confirm = screen.getByRole('button', { name: 'Yes, do it' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    // Focus starts on the first control; Shift+Tab wraps to the last.
    expect(confirm).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open dialog' })).toHaveFocus();
  });
});
