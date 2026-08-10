import { useState } from 'react';
import { getEmployeeProfilePhoto, employeeInitials } from '../utils/employeePhoto';

/**
 * THE one employee-avatar component — used everywhere an employee photo is shown so
 * the broken-image / fallback logic exists in exactly one place.
 *
 * Behaviour (per spec §2–§4):
 *   • renders the photo ONLY when a valid URL resolves;
 *   • if the image fails to load, it is removed and the INITIALS are shown — never a
 *     broken-image icon and never the alt text rendered inside the circle;
 *   • no photo at all → initials straight away.
 *
 * The employee name is used ONLY for `alt` and to derive initials; it is never the
 * visible fallback as raw text.
 *
 * Props:
 *   emp                 employee-like object (raw hr_* record OR enriched {photo,...})
 *   name                explicit name (else derived from emp)
 *   photo               explicit photo value (else derived from emp)
 *   className           container classes (size / shape / background / ring)
 *   initialsClassName   text classes for the initials
 *   alt                 explicit alt (else the name)
 */
export default function Avatar({ emp, name, photo, className = '', initialsClassName = '', alt, style }) {
  const src = getEmployeeProfilePhoto(emp || { photo, hr_hremployee1: name });
  const label = name || emp?.hr_hremployee1 || emp?.name || emp?.employeeName || '';
  const initials = employeeInitials(label);

  // Track WHICH src failed, so a later photo change (new src) is retried instead of
  // being stuck on the failed state. setState in an event handler — no effect, no
  // cascading-render lint issue.
  const [erroredSrc, setErroredSrc] = useState(null);
  const showImg = !!src && erroredSrc !== src;

  return (
    <div className={`overflow-hidden flex items-center justify-center ${className}`} style={style}>
      {showImg ? (
        <img
          src={src}
          alt={alt || label || 'Profile photo'}
          className="w-full h-full object-cover"
          onError={() => setErroredSrc(src)}
        />
      ) : (
        <span className={initialsClassName}>{initials}</span>
      )}
    </div>
  );
}
