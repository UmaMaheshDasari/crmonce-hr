/**
 * Minimal RFC-5545 iCalendar generation for approved leave (all-day event).
 * Pure, no I/O — unit-testable. Returned attachment matches Graph's
 * fileAttachment shape (base64 contentBytes).
 */
const pad = (n) => String(n).padStart(2, '0');
const dateOnly = (s) => String(s).slice(0, 10).replace(/-/g, ''); // YYYYMMDD

function addDayUTC(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1); // DTEND is exclusive for all-day events
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function stamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const escText = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');

function buildLeaveICS({ uid, employeeName, leaveType, from, to }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CRMONCE//HR//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid || 'leave-' + stamp()}@crmonce`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;VALUE=DATE:${dateOnly(from)}`,
    `DTEND;VALUE=DATE:${addDayUTC(to)}`,
    `SUMMARY:${escText(`Leave - ${employeeName} (${leaveType})`)}`,
    `DESCRIPTION:${escText(`Approved ${leaveType} for ${employeeName}`)}`,
    'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function icsAttachment(ics, filename = 'leave.ics') {
  return {
    name: filename,
    contentType: 'text/calendar; method=PUBLISH',
    contentBytes: Buffer.from(ics, 'utf8').toString('base64'),
  };
}

module.exports = { buildLeaveICS, icsAttachment };
