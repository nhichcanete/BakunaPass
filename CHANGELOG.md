# Changelog

## 1.6.0 - Self-registration and account role management

### Added
- Activated self-registered accounts immediately with the restricted `facility_user` role; users can manage only their own requisitions and view stock.
- Added administrator controls for changing registered users' roles, with role changes invalidating prior sessions.
- Documented credentialed role accounts for realistic demonstrations and removed the local-demo sign-in bypass.

### Updated
- Updated sign-up, account-management, deployment, and role-permission documentation to match the new onboarding flow.

## 1.5.0 - Staff MFA and role-specific workspace

### Added
- Required authenticator-app TOTP enrollment and verification for staff sign-in, including encrypted secrets and single-use recovery codes.
- Expanded access requests with staff/employee ID and job title; administrators review these details before assigning a role.
- Added the clinic supervisor role and role-specific navigation, patient registry access, and service permissions.
- Scoped browser-local vaccination records to the signed-in health-worker account and removed seeded resident records.

### Updated
- Updated product branding, aligned button hover states with the plum/lavender palette, and clarified the system's purpose and deployment boundaries.

## 1.4.0 - Private workspace and staff approval

### Added
- Made sign-in the public landing page and protected the dashboard routes behind an authenticated session.
- Added one-hour HttpOnly, same-site session cookies and sign-out handling; browser code no longer trusts a client-stored role to open the workspace.
- Changed public account creation into a staff access request containing work identity and facility details; requests remain pending until an administrator approves and assigns a role.
- Added an administrator portal card to review, approve, assign roles, or reject pending requests.
- Added schema migration support for account status and staff identity fields.

### Security
- The local demo remains loopback-only and is explicitly distinct from configured user authentication.
- Public registration and login remain disabled until a JWT secret and trusted bootstrap user are configured.
- The operations page, including its vaccination registry views, redirects unauthenticated visitors to sign-in.

## 1.3.0 - Operations portal and account experience

### Added
- Separate responsive `/auth` page for sign-in and staff access requests.
- Health-worker self-registration when JWT authentication is configured; passwords are salted and stored as scrypt hashes, and registration cannot assign elevated roles.
- Refreshed responsive dashboard styles, navigation, and service cards; improved small-screen layouts and reduced-motion behavior.
- Added browser and integration coverage for account registration, role constraints, auth-page delivery, and registration/login flows.

## 1.2.0 - SIA service integration milestone

### Added
- Separate Clinic Requisition and Vaccine Cold-Chain Telemetry HTTP services behind the API Gateway.
- SQLite-backed current batch readings, telemetry history, and requisition records.
- JSON and XML telemetry ingestion and `Accept`-based JSON/XML content negotiation.
- HTTP service-to-service verification before a batch-linked requisition can be approved; breached batches are rejected and unavailable telemetry fails closed.
- Gateway JWT issuance, role-based route access, correlation IDs, configurable API rate limiting, and CORS allowlisting.
- API contract, JSON/XML payload examples, integration tests, and an importable Postman collection for the course requirements.
- Added institution-neutral service branding and clear labeling for sample data.

### Security and deployment notes
- Replaced credential-like SMTP values in `.env.example` with empty placeholders. Any previously committed provider credential must still be rotated.
- Local development mode permits API access only from loopback. Configure JWT users and a strong signing secret before exposing the gateway.
- The SQLite database, demonstration fixtures, process-local rate limits, and in-process service hosting are not a production deployment architecture.

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
Production REST-to-SOAP legacy HIS integration, external weather-based risk assessment, offline telemetry queuing, production identity-provider integration, durable audit events, deployment automation, operational backup/restore, and verification against authorized health authority policies.
