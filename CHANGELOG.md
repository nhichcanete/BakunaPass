# Changelog

## 1.1.0 - Fixes and hardening

### Bug fixes
- **Status calculated against today's date.** `app.js` used a hardcoded `2026-09-30` in six places (summary, chart, filter, sort, record list), so statuses went stale. It now uses the current date.
- **Stored XSS closed.** Resident name, address, phone, email, dose count and status text are now HTML-escaped in the registry list. Previously only the notification dropdown was escaped.
- **Records are identified by unique `id`, not name.** Edit and Delete used to match on name, so two residents with the same name could modify the wrong record. Every record now gets an id (`ensureEntryIds` also upgrades records already saved in your browser automatically).
- **Pass review date fixed.** `getPassExpiryDate` had a dead branch (`booster ? 180 : 180`). Records with a booster now return no review date, matching the "Booster complete = valid" status rule. The 180-day window is a named constant, `PRIMARY_SERIES_VALID_DAYS`, shared by the status check and the review date.
- **Timezone-safe date maths.** The review date is calculated in UTC so it can't shift by a day depending on the device's timezone.

### Validation and safety
- Most recent dose date cannot be in the future (date picker `max` plus a validation message on submit).
- **Clear all** now asks for confirmation and reminds you to export a CSV first.

### Security
- `/api/notifications` is no longer open to anyone: localhost-only by default, or bearer-token protected via `NOTIFICATION_API_TOKEN` (timing-safe comparison).
- Per-IP rate limiting (`NOTIFICATION_RATE_LIMIT`, default 10 per minute), returning HTTP 429.
- Static files now send `Content-Security-Policy` (no framing, same-origin only) and `Referrer-Policy: no-referrer`.
- Notification form gained an "Access token" field; the token is stored in `sessionStorage` only and sent as an `Authorization` header.

### Tests (12 to 22)
- New: unique ids, future-date detection, pass review date rules, token required / wrong token / correct token, rate limiting, SMS delivery path, security headers.

### Config
- `.env.example` adds `NOTIFICATION_API_TOKEN` and `NOTIFICATION_RATE_LIMIT`.

## Not yet done (suggested next)
Signed QR verification, dose history with vaccine brand/lot, bulk and scheduled reminders, SMS option in the UI, SQLite storage with login and audit log, CSV import, and removing or relabelling the "Department of Health" branding if this is not an official DOH product.
