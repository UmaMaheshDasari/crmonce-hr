import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';

/**
 * Enterprise dialog (Keka/Zoho/Darwinbox-style). Portaled + centered, capped at
 * 90vh, laid out as a flex column so:
 *   • the header stays FIXED at the top,
 *   • the body SCROLLS (ModalBody),
 *   • the footer stays STICKY at the bottom (ModalFooter),
 *   • the page behind is scroll-locked (never scrolls under the dialog).
 *
 * Usage (form dialog):
 *   <Modal title="…" subtitle="…" onClose={fn} size="lg">
 *     <form onSubmit={…} className="flex flex-col min-h-0 flex-1">
 *       <ModalBody> …fields… </ModalBody>
 *       <ModalFooter> …buttons… </ModalFooter>
 *     </form>
 *   </Modal>
 */
const SIZES = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };

export default function Modal({ title, subtitle, onClose, size = 'lg', children, closeOnBackdrop = true }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';                 // lock page scroll
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        role="dialog" aria-modal="true"
        className={`bg-white w-full ${SIZES[size] || SIZES.lg} rounded-2xl shadow-2xl max-h-[90dvh] flex flex-col overflow-hidden`}
      >
        {/* Fixed header — always visible */}
        <div className="flex items-start justify-between gap-3 px-5 sm:px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-bold text-gray-900 truncate">{title}</h2>}
            {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close"
              className="p-2 -mr-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg flex-shrink-0">
              <XMarkIcon className="w-5 h-5" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

// Scrolls; sits between the fixed header and the sticky footer.
export function ModalBody({ children, className = '' }) {
  return <div className={`flex-1 overflow-y-auto px-5 sm:px-6 py-5 ${className}`}>{children}</div>;
}

// Sticky footer — always visible while the body scrolls.
export function ModalFooter({ children, className = '' }) {
  return <div className={`flex items-center justify-end gap-3 px-5 sm:px-6 py-4 border-t border-gray-100 flex-shrink-0 bg-white ${className}`}>{children}</div>;
}
