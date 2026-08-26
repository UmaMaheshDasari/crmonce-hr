import { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';

// The consistent masked representation used everywhere financial amounts are hidden.
const MASK = '₹••••••';

/** INR formatting matching the rest of the app: ₹50,000 (null/invalid → '—'). */
export function formatINR(v) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return `₹${Number(v).toLocaleString('en-IN')}`;
}

/**
 * SensitiveAmount — masks a monetary amount on screen by DEFAULT; a small eye button
 * reveals it locally (this instance only — clicking one eye never reveals others).
 *
 *  • DISPLAY-ONLY: the numeric `value` is never mutated, so sorting/filtering/totals keep
 *    using the real number. This is NOT a security control — render an amount only when
 *    the user is already authorized to see it (backend permissions remain the source of
 *    truth). If a user isn't authorized, don't render this at all.
 *  • PRINT / PDF ALWAYS shows the real value (via the `print:` variants), so a printed
 *    payslip is never masked regardless of the on-screen eye state.
 *
 * Usage: <SensitiveAmount value={grossSalary} label="salary" />
 * Pass `format` to reuse a page's existing currency formatter.
 */
export default function SensitiveAmount({
  value,
  format = formatINR,
  label = 'amount',
  className = '',
  valueClassName = 'tabular-nums',
  iconClassName = 'w-4 h-4',
}) {
  const [visible, setVisible] = useState(false);
  // Accept a raw number (formatted here) OR an already-formatted currency string.
  const real = typeof value === 'string' ? value : format(value);
  // Nothing to hide when there's no amount (e.g. no salary structure / not provided) —
  // render the placeholder plainly, with no mask and no reveal control.
  if (real === null || real === undefined || real === '' || real === '—') {
    return <span className={`tabular-nums ${className}`}>{real || '—'}</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {/* On screen: masked until the eye is clicked */}
      <span className={`${valueClassName} print:hidden`}>{visible ? real : MASK}</span>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setVisible((v) => !v); }}
        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        title={visible ? `Hide ${label}` : `Show ${label}`}
        className="print:hidden inline-flex items-center text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 rounded-sm leading-none align-middle"
      >
        {visible ? <EyeSlashIcon className={iconClassName} /> : <EyeIcon className={iconClassName} />}
      </button>
      {/* In print / PDF: always the real value (masking never reaches a printed payslip) */}
      <span className={`${valueClassName} hidden print:inline`}>{real}</span>
    </span>
  );
}
