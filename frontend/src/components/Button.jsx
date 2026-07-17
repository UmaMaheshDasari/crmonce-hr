import { forwardRef } from 'react';

/**
 * Reusable button — icon + text always on ONE line (never wraps).
 *  variant: primary | secondary | success | danger | amber | ghost
 *  size:    sm (36px) | md (44px) | lg (48px)
 *  icon:    a heroicon component (rendered left of the text at a fixed size)
 *  loading: shows a spinner in place of the icon and disables the button
 *
 * Horizontal padding tightens on small screens BEFORE any wrapping is allowed
 * (whitespace-nowrap guarantees the label stays on a single line).
 */
const SIZE = {
  sm: 'h-9  px-3   sm:px-3.5 text-sm      gap-1.5', // 36px
  md: 'h-11 px-3.5 sm:px-5   text-sm      gap-2',   // 44px
  lg: 'h-12 px-4   sm:px-6   text-[15px]  gap-2',   // 48px
};
const ICON = { sm: 'w-4 h-4', md: 'w-[18px] h-[18px]', lg: 'w-5 h-5' };

const VARIANT = {
  primary:   'bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 shadow-md shadow-indigo-200/60 disabled:shadow-none',
  secondary: 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 hover:border-gray-300 active:bg-gray-100',
  success:   'bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 shadow-md shadow-emerald-200/60 disabled:shadow-none',
  danger:    'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-md shadow-red-200/60 disabled:shadow-none',
  amber:     'bg-amber-500 text-white hover:bg-amber-600 active:bg-amber-700 shadow-md shadow-amber-200/60 disabled:shadow-none',
  ghost:     'bg-transparent text-gray-600 hover:bg-gray-100 active:bg-gray-200',
};

const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', icon: Icon, loading = false, disabled = false,
    type = 'button', fullWidth = false, className = '', children, ...props }, ref) {

  const base = 'inline-flex items-center justify-center whitespace-nowrap font-semibold rounded-xl ' +
    'transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed select-none';

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${base} ${SIZE[size]} ${VARIANT[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {loading
        ? <span className={`${ICON[size]} border-2 border-current border-t-transparent rounded-full animate-spin`} aria-hidden />
        : (Icon ? <Icon className={`${ICON[size]} flex-shrink-0`} aria-hidden /> : null)}
      {children}
    </button>
  );
});

export default Button;
