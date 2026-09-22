import { useEffect, useRef } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** Accessible toggle switch built on a native checkbox. */
export function Toggle({
  id,
  label,
  checked,
  onChange,
  description,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-0.5 size-4 shrink-0 accent-slate-700"
      />
      <label htmlFor={id} className="text-sm leading-snug">
        <span className="font-medium">{label}</span>
        {description !== undefined && (
          <span className="block text-xs opacity-70">{description}</span>
        )}
      </label>
    </div>
  );
}

/** Segmented radio group used for modes. */
export function SegmentedControl<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
        {legend}
      </legend>
      <div className="flex gap-1 rounded-md bg-black/5 p-1">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex-1 cursor-pointer rounded px-2 py-1 text-center text-sm ${
              value === option.value
                ? 'bg-white font-semibold shadow'
                : 'opacity-70 hover:opacity-100'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
            {option.hint !== undefined && <span className="sr-only"> — {option.hint}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const styles =
    variant === 'primary'
      ? 'bg-slate-800 text-white hover:bg-slate-700'
      : variant === 'danger'
        ? 'bg-red-700 text-white hover:bg-red-600'
        : 'bg-black/5 hover:bg-black/10';
  return (
    <button
      type={type}
      onClick={onClick}
      {...rest}
      className={`rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-black/10 py-3 first:border-t-0">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-70">{title}</h2>
      {children}
    </section>
  );
}

/**
 * QA-02 accessible confirm dialog: focus is trapped while open, Escape
 * dismisses (cancel), and focus returns to the previously focused element
 * when the dialog closes.
 */
export function ConfirmDialog({
  label,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
  confirmDisabled = false,
}: {
  label: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  confirmDisabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    // Move focus into the dialog.
    const firstButton = container?.querySelector<HTMLButtonElement>('button');
    firstButton?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || container === null) return;
      const focusable = [
        ...(container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Return focus to where the dialog was opened from.
      previouslyFocused?.focus();
    };
  }, [onCancel]);
  return (
    <div
      ref={containerRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={label}
      className="rounded bg-black/5 p-3"
    >
      {children}
      <div className="mt-2 flex gap-2">
        <Button
          variant={danger ? 'danger' : 'secondary'}
          onClick={onConfirm}
          {...(confirmDisabled ? { disabled: true } : {})}
        >
          {confirmLabel}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
