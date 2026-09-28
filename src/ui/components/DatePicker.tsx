import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface DatePickerProps {
  value: string; // ISO format 'YYYY-MM-DD' or ''
  onChange: (value: string) => void;
  'aria-label'?: string;
  placeholder?: string;
  id?: string;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function formatISO(year: number, monthIndex: number, day: number): string {
  const y = String(year);
  const m = String(monthIndex + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISO(text: string): { year: number; month: number; day: number } | null {
  if (!text) return null;
  const parts = text.split('-').map(Number);
  if (parts.length !== 3 || parts.some((p) => isNaN(p))) return null;
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  return { year, month: month - 1, day };
}

export function DatePicker({
  value,
  onChange,
  'aria-label': ariaLabel,
  placeholder = 'YYYY-MM-DD',
  id,
}: DatePickerProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse current value or default to today's date
  const parsedValue = useMemo(() => parseISO(value), [value]);

  const today = useMemo(() => {
    const d = new Date();
    return {
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      iso: formatISO(d.getFullYear(), d.getMonth(), d.getDate()),
    };
  }, []);

  const [viewOverride, setViewOverride] = useState<{ year: number; month: number } | null>(null);

  const currentView = useMemo(() => {
    if (viewOverride) return viewOverride;
    if (parsedValue) return { year: parsedValue.year, month: parsedValue.month };
    return { year: today.year, month: today.month };
  }, [viewOverride, parsedValue, today]);

  const viewYear = currentView.year;
  const viewMonth = currentView.month;

  const close = () => {
    setIsOpen(false);
    setViewOverride(null);
  };

  // Click outside and Escape key handling
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewOverride({ year: viewYear - 1, month: 11 });
    } else {
      setViewOverride({ year: viewYear, month: viewMonth - 1 });
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewOverride({ year: viewYear + 1, month: 0 });
    } else {
      setViewOverride({ year: viewYear, month: viewMonth + 1 });
    }
  };

  // Compute 42 calendar grid cells (6 rows × 7 cols)
  const calendarCells = useMemo(() => {
    const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
    const daysInCurrentMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    const cells: Array<{
      year: number;
      month: number;
      day: number;
      iso: string;
      isCurrentMonth: boolean;
      isSelected: boolean;
      isToday: boolean;
    }> = [];

    // Previous month padding
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i;
      const month = viewMonth === 0 ? 11 : viewMonth - 1;
      const year = viewMonth === 0 ? viewYear - 1 : viewYear;
      const iso = formatISO(year, month, day);
      cells.push({
        year,
        month,
        day,
        iso,
        isCurrentMonth: false,
        isSelected: iso === value,
        isToday: iso === today.iso,
      });
    }

    // Current month days
    for (let d = 1; d <= daysInCurrentMonth; d++) {
      const iso = formatISO(viewYear, viewMonth, d);
      cells.push({
        year: viewYear,
        month: viewMonth,
        day: d,
        iso,
        isCurrentMonth: true,
        isSelected: iso === value,
        isToday: iso === today.iso,
      });
    }

    // Next month padding to fill grid
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const month = viewMonth === 11 ? 0 : viewMonth + 1;
      const year = viewMonth === 11 ? viewYear + 1 : viewYear;
      const iso = formatISO(year, month, d);
      cells.push({
        year,
        month,
        day: d,
        iso,
        isCurrentMonth: false,
        isSelected: iso === value,
        isToday: iso === today.iso,
      });
    }

    return cells;
  }, [viewYear, viewMonth, value, today.iso]);

  return (
    <div className="btsl-datepicker" ref={containerRef}>
      <div className="btsl-datepicker__input-row">
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onClick={() => setIsOpen(true)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          className="btsl-input btsl-input--date"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={`Open calendar for ${ariaLabel || 'date'}`}
          className="btsl-datepicker__toggle"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </button>
      </div>

      {isOpen && (
        <div className="btsl-datepicker__popover" role="dialog" aria-modal="false">
          <div className="btsl-datepicker__header">
            <button
              type="button"
              className="btsl-datepicker__nav-btn"
              onClick={prevMonth}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className="btsl-datepicker__title">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              className="btsl-datepicker__nav-btn"
              onClick={nextMonth}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="btsl-datepicker__weekdays">
            {WEEKDAY_NAMES.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>

          <div className="btsl-datepicker__grid">
            {calendarCells.map((cell) => (
              <button
                key={cell.iso}
                type="button"
                className={`btsl-datepicker__day ${
                  !cell.isCurrentMonth ? 'btsl-datepicker__day--outside' : ''
                } ${cell.isToday ? 'btsl-datepicker__day--today' : ''} ${
                  cell.isSelected ? 'btsl-datepicker__day--selected' : ''
                }`.trim()}
                onClick={() => {
                  onChange(cell.iso);
                  close();
                }}
              >
                {cell.day}
              </button>
            ))}
          </div>

          <div className="btsl-datepicker__footer">
            <button
              type="button"
              className="btsl-btn"
              style={{ padding: '2px 8px', fontSize: '12px', minHeight: '24px' }}
              onClick={() => {
                onChange('');
                close();
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="btsl-btn btsl-btn--primary"
              style={{ padding: '2px 8px', fontSize: '12px', minHeight: '24px' }}
              onClick={() => {
                onChange(today.iso);
                close();
              }}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
