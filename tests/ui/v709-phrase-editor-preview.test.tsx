import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PhraseEditor } from '@/entrypoints/options/PhraseEditor';

/**
 * V7-09 UI: the phrase editor previews a rule against a bounded local sample
 * BEFORE saving, shows estimated matches and conflicts, and supports the
 * whole-word mode. No raw regex is exposed anywhere.
 */

function baseProps() {
  return {
    phrases: [] as string[],
    phraseRules: [] as { phrase: string; wholeWord: boolean }[],
    onAdd: vi.fn(),
    onRemove: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  });
});

describe('V7-09: PhraseEditor live preview', () => {
  it('shows the preview with an honest sample denominator as you type', async () => {
    render(<PhraseEditor {...baseProps()} />);
    const input = screen.getByLabelText(/phrase to block/i);
    fireEvent.change(input, { target: { value: 'ai generated' } });
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toMatch(/matches? in the (?:12|local) sample|~\d+ of \d+/i);
    });
    expect(document.body.textContent).toMatch(/ai generated/i);
  });

  it('whole-word toggle changes the estimate for a short word', async () => {
    render(<PhraseEditor {...baseProps()} />);
    const input = screen.getByLabelText(/phrase to block/i);
    fireEvent.change(input, { target: { value: 'ai' } });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/match(?:es)? inside many words/i);
    });
    const toggle = screen.getByRole('checkbox', { name: /whole word/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      // The "too short" substring warning disappears in whole-word mode; the
      // boundary-aware estimate replaces it.
      expect(document.body.textContent).not.toMatch(/match(?:es)? inside many words/i);
    });
  });

  it('lists conflicting safe titles before saving', async () => {
    render(<PhraseEditor {...baseProps()} />);
    fireEvent.change(screen.getByLabelText(/phrase to block/i), {
      target: { value: 'history' },
    });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/human-made title|also matches/i);
    });
    expect(document.body.textContent).toContain('The history of bread');
  });

  it('does not save on Enter while previewing; saves only on Add', async () => {
    const onAdd = vi.fn();
    const props = { ...baseProps(), onAdd };
    render(<PhraseEditor {...props} />);
    const input = screen.getByLabelText(/phrase to block/i);
    fireEvent.change(input, { target: { value: 'unsettling ai voices' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /add phrase/i }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('unsettling ai voices', false));
  });

  it('saving a whole-word rule passes wholeWord=true', async () => {
    const onAdd = vi.fn();
    render(<PhraseEditor {...baseProps()} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText(/phrase to block/i), {
      target: { value: 'exact' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /whole word/i }));
    fireEvent.click(screen.getByRole('button', { name: /add phrase/i }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('exact', true));
  });

  it('renders existing whole-word rules distinctly and removes them', async () => {
    const onRemove = vi.fn();
    render(
      <PhraseEditor
        {...baseProps()}
        phrases={['legacy phrase']}
        phraseRules={[{ phrase: 'exact word', wholeWord: true }]}
        onRemove={onRemove}
      />,
    );
    expect(document.body.textContent).toContain('legacy phrase');
    expect(document.body.textContent).toContain('exact word');
    expect(document.body.textContent).toMatch(/whole word/i);
    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeButtons[0]!);
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
  });
});
