/**
 * Server-side employee profile-photo resolution — the SINGLE source of truth shared
 * by the employee GET/list AND every enrichment (advance / salary / goals /
 * celebrations), so a removed photo shows initials EVERYWHERE.
 *
 * Priority:
 *   1. personal photo (hr_personalphotourl) — always wins
 *   2. if the employee REMOVED their photo (hr_photoremoved='true') → '' (initials);
 *      this suppresses the default so "Remove" is honoured and the CRMONCE default is
 *      NOT restored. Set on remove, cleared on the next personal upload.
 *   3. default photo (hr_photourl)
 *   4. '' → the caller (Avatar) shows initials
 */
const isPhotoRemoved = (e) => String(e && e.hr_photoremoved).toLowerCase() === 'true';

function resolvePhoto(e) {
  if (!e) return '';
  if (e.hr_personalphotourl) return e.hr_personalphotourl;   // personal always wins
  if (isPhotoRemoved(e)) return '';                          // removed → suppress default → initials
  return e.hr_photourl || '';
}

// The photo columns to $select wherever a photo is resolved.
const PHOTO_COLS = 'hr_photourl,hr_personalphotourl,hr_photoremoved';

module.exports = { resolvePhoto, isPhotoRemoved, PHOTO_COLS };
