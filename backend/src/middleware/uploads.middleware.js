/**
 * IMAGE-ONLY static server for the uploads directory.
 *
 * Uploaded profile photos live on disk under the uploads dir. The SPA is hosted
 * separately and only proxies `/api` to this backend, so a bare "/uploads/x.jpg" is
 * unreachable from the browser in production. Mounting this at `/api/uploads` makes
 * profile photos load in EVERY deployment (dev proxy + prod same-origin).
 *
 * Restricted to image extensions so it never widens exposure of non-image documents
 * (Aadhaar / PAN / cheque PDFs) that also live in the uploads dir. Non-image or
 * missing files → 404 (the frontend <Avatar> then falls back to initials).
 */
const express = require('express');

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

/**
 * @param {string} uploadsDir absolute path to the uploads directory
 * @returns Express middleware that serves ONLY image files from uploadsDir
 */
function imageUploadsStatic(uploadsDir) {
  const serve = express.static(uploadsDir, {
    // A profile photo URL changes filename on replace + carries ?v=<modifiedon>, so
    // a long cache is safe and avoids a re-download on every avatar render.
    maxAge: '7d',
    fallthrough: false,   // a missing image → 404 (not next()), so the avatar falls back
  });
  return (req, res, next) => {
    if (!IMAGE_RE.test(req.path)) return res.status(404).end();
    return serve(req, res, next);
  };
}

module.exports = { imageUploadsStatic, IMAGE_RE };
