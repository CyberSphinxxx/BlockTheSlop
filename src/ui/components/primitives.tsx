import { useEffect, useRef } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** Accessible toggle switch built on a native checkbox in Specimen style. */
export function Toggle({
  id,
  label,
  checked,
  onChange,
  description,
  disabled = false,
  disabledReason,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label htmlFor={id} className="btsl-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="bts-checkbox"
      />
      <span>
        <b>{label}</b>
        {disabled && disabledReason !== undefined && (
          <span role="status" className="btsl-help" style={{ display: 'block' }}>
            {disabledReason}
          </span>
        )}
        {description !== undefined && (
          <span className="btsl-help" style={{ display: 'block' }}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/** Segmented radio group used for modes in Specimen style. */
export function SegmentedControl<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  autoWidth = false,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  autoWidth?: boolean;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {legend ? (
        <legend className="btsl-help" style={{ marginBottom: 'var(--sp-1)' }}>
          {legend}
        </legend>
      ) : null}
      <div
        className={`btsl-seg ${autoWidth ? 'btsl-seg--auto' : ''}`}
        role="radiogroup"
        aria-label={legend || name}
      >
        {options.map((option) => {
          const isSelected = value === option.value;
          return (
            <label
              key={option.value}
              data-checked={isSelected ? 'true' : 'false'}
              aria-pressed={isSelected ? 'true' : 'false'}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={isSelected}
                onChange={() => onChange(option.value)}
                style={{
                  position: 'absolute',
                  width: '1px',
                  height: '1px',
                  padding: 0,
                  margin: '-1px',
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                  whiteSpace: 'nowrap',
                  border: 0,
                }}
              />
              {option.label}
              {option.hint !== undefined && (
                <span
                  style={{
                    position: 'absolute',
                    width: '1px',
                    height: '1px',
                    padding: 0,
                    margin: '-1px',
                    overflow: 'hidden',
                    clip: 'rect(0, 0, 0, 0)',
                    whiteSpace: 'nowrap',
                    border: 0,
                  }}
                >
                  {' '}
                  — {option.hint}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  className = '',
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const variantClass =
    variant === 'primary' ? 'btsl-btn--primary' : variant === 'danger' ? 'btsl-btn--danger' : '';
  return (
    <button
      type={type}
      onClick={onClick}
      {...rest}
      className={`btsl-btn ${variantClass} ${className}`.trim()}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="btsl-panel" style={{ marginBottom: 'var(--sp-4)' }}>
      <h2 className="btsl-h">{title}</h2>
      {children}
    </section>
  );
}

/**
 * QA-02 accessible confirm dialog in Specimen panel style.
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
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  return (
    <div
      ref={containerRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={label}
      className="btsl-panel"
      style={{ marginTop: 'var(--sp-2)' }}
    >
      {children}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
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
