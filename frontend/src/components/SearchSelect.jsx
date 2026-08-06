import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUpDownIcon, CheckIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';

/**
 * A searchable, keyboard-navigable Select whose menu is PORTALED to document.body
 * with position:fixed and a very high z-index — so it can never be clipped or
 * hidden behind a modal/header/overflow container (the classic "dropdown behind
 * the popup" bug). Flips upward automatically when there isn't room below.
 *
 * Dependency-free; styled to match the app's native inputs (h-10, rounded-lg,
 * indigo focus ring) so the design is unchanged.
 *
 * Props: value, onChange(value), options: [{value,label}], placeholder,
 *        searchable=true, disabled, error, id.
 */
const MENU_MAX = 288;

export default function SearchSelect({ value, onChange, options = [], placeholder = 'Select…', searchable = true, disabled = false, error = false, id }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  const selected = useMemo(() => options.find(o => String(o.value) === String(value)) || null, [options, value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Position the menu below (or above) the trigger, in viewport (fixed) coords.
  const reposition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const flip = below < Math.min(MENU_MAX, 220) && above > below;
    setPos({
      left: r.left,
      width: r.width,
      flip,
      top: flip ? undefined : r.bottom + 4,
      bottom: flip ? (window.innerHeight - r.top + 4) : undefined,
      maxHeight: Math.max(140, Math.min(MENU_MAX, (flip ? above : below) - 12)),
    });
  };

  useLayoutEffect(() => { if (open) reposition(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => reposition();
    const onResize = () => reposition();
    // capture=true so scrolling INSIDE the modal also repositions the menu.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    const onDown = (e) => {
      if (!triggerRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    if (searchable) setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, searchable]);

  useEffect(() => { setActive(0); }, [query, open]);
  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const node = menuRef.current.querySelector(`[data-idx="${active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (opt) => { if (!opt) return; onChange?.(opt.value); setOpen(false); setQuery(''); triggerRef.current?.focus(); };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); return; }
      // Type-to-search: opening the menu seeded with the pressed character.
      if (searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { setOpen(true); setQuery(e.key); return; }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(filtered.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(filtered[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  const triggerCls = `w-full h-10 px-3 flex items-center justify-between gap-2 bg-gray-50 border rounded-lg text-sm text-left transition-all
    ${error ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200'}
    ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400'}`;

  return (
    <>
      <button type="button" id={id} ref={triggerRef} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => !disabled && setOpen(o => !o)} onKeyDown={onKeyDown}
        className={triggerCls}>
        <span className={`truncate ${selected ? 'text-gray-900' : 'text-gray-400'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronUpDownIcon className="w-4 h-4 text-gray-400 shrink-0" />
      </button>

      {open && pos && createPortal(
        <div ref={menuRef} role="listbox"
          style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, zIndex: 99999 }}
          className="bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden">
          {searchable && (
            <div className="p-2 border-b border-gray-100">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
                <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
                  placeholder="Search…"
                  className="w-full h-9 pl-8 pr-3 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400" />
              </div>
            </div>
          )}
          <div className="overflow-y-auto py-1" style={{ maxHeight: pos.maxHeight }}>
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-sm text-gray-400 text-center">No matches</p>
            ) : filtered.map((o, i) => {
              const isSel = String(o.value) === String(value);
              return (
                <button type="button" key={o.value ?? i} data-idx={i} role="option" aria-selected={isSel}
                  onMouseEnter={() => setActive(i)} onClick={() => choose(o)}
                  className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2 ${i === active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'}`}>
                  <span className="truncate">{o.label}</span>
                  {isSel && <CheckIcon className="w-4 h-4 text-indigo-600 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
