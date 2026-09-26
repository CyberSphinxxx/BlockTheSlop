import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompetitorImportSection } from '@/entrypoints/options/CompetitorImportSection';
import { defaultRules } from '@/domain/rules';
import type { UserRules } from '@/domain/rules';

/**
 * V7-11 UI: the competitor import preview on the Import/export tab. File
 * selection produces a PREVIEW ONLY; Apply is the single explicit mutation,
 * persisted through the parent's onApply; Discard and read failures change
 * nothing.
 */

const UC_OK = 'UCX12345678901234567890a';

describe('V7-11: CompetitorImportSection', () => {
  let saveRules: ReturnType<typeof vi.fn<(next: UserRules) => Promise<boolean>>>;

  beforeEach(() => {
    saveRules = vi.fn<(next: UserRules) => Promise<boolean>>(async () => true);
  });

  function renderSection(
    onApply: (next: UserRules) => Promise<boolean> = saveRules,
  ): ReturnType<typeof render> {
    return render(<CompetitorImportSection rules={defaultRules()} onApply={onApply} />);
  }

  async function pickFile(text: string): Promise<void> {
    const input = screen.getByLabelText('Competitor rules file');
    const file = new File([text], 'blocktube-export.json', { type: 'application/json' });
    await userEvent.setup().upload(input as HTMLInputElement, file);
  }

  it('shows a mapping preview without touching rules until Apply', async () => {
    renderSection();
    await pickFile(JSON.stringify({ blockedChannels: [UC_OK], blockedKeywords: ['slop'] }));

    expect(await screen.findByText(/Preview: blocktube/i)).toBeInTheDocument();
    expect(screen.getByText(/1 channel ID/)).toBeInTheDocument();
    expect(screen.getByText(/1 keyword phrase/)).toBeInTheDocument();
    expect(saveRules).not.toHaveBeenCalled();
  });

  it('Apply persists the merged rules and flips the preview to applied', async () => {
    const user = userEvent.setup();
    renderSection();
    await pickFile(JSON.stringify({ blockedChannels: [UC_OK], blockedKeywords: ['slop'] }));
    await user.click(await screen.findByRole('button', { name: 'Apply import' }));

    await waitFor(() => expect(screen.getByText('Applied.')).toBeInTheDocument());
    expect(saveRules).toHaveBeenCalledTimes(1);
    const merged = saveRules.mock.calls[0]?.[0];
    expect(merged?.blockedChannelIds).toContain(UC_OK);
    expect(merged?.blockedPhraseRules.map((p) => p.phrase)).toContain('slop');
  });

  it('Discard applies nothing and clears the preview', async () => {
    const user = userEvent.setup();
    renderSection();
    await pickFile(JSON.stringify({ blockedKeywords: ['slop'] }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByText(/Preview: blocktube/i)).not.toBeInTheDocument());
    expect(saveRules).not.toHaveBeenCalled();
  });

  it('reports an unreadable file without applying anything', async () => {
    renderSection();
    await pickFile('{not json');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/i);
    expect(saveRules).not.toHaveBeenCalled();
  });

  it('apply failure shows a visible error and keeps rules unchanged', async () => {
    const user = userEvent.setup();
    const failing = vi.fn<(next: UserRules) => Promise<boolean>>(async () => false);
    renderSection(failing);
    await pickFile(JSON.stringify({ blockedChannels: [UC_OK] }));
    await user.click(await screen.findByRole('button', { name: 'Apply import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed/i);
    expect(saveRules).not.toHaveBeenCalled();
  });
});
