# BakunaPass API Contract

## Gateway and service topology

The API Gateway listens on port `3000`. Distinct backend services listen on ports `5001` through `5005`: Clinic Requisition, Cold-Chain Telemetry, Legacy HIS REST-to-SOAP Adapter, simulated SOAP HIS, and Shipment Risk Mashup. Use the gateway for client requests; internal service ports bind to loopback by default.

All responses contain an `X-Correlation-ID`. Gateway errors use this JSON structure:

```json
{
  "error": "RESOURCE_NOT_FOUND",
  "message": "The requested vaccine telemetry batch record could not be found.",
  "details": { "resource": "TelemetryBatch", "batchId": "VAX-9999" },
  "timestamp": "2026-10-26T07:00:00.000Z",
  "correlationId": "7c973407-863b-4147-a1c0-9f36b25333ce"
}
```

### Gateway and authentication endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Gateway liveness |
| `GET` | `/api/ready` | Readiness checks for all downstream services |
| `GET` | `/api/v1/auth/config` | Login, registration, MFA, and local-session availability |
| `GET` | `/api/v1/auth/session` | Current signed-in session |
| `POST` | `/api/v1/auth/token` | Validate a password and begin MFA enrollment/challenge |
| `POST` | `/api/v1/auth/mfa/setup` | Create an encrypted authenticator secret for first-time enrollment |
| `POST` | `/api/v1/auth/mfa/verify` | Verify TOTP/recovery code and issue a one-hour session |
| `POST` | `/api/v1/auth/register` | Create a limited `facility_user` account |
| `POST` | `/api/v1/auth/logout` | Clear the browser session cookie |
| `GET` | `/api/v1/admin/accounts` | List self-registered staff accounts (admin only) |
| `PATCH` | `/api/v1/admin/accounts/{username}` | Change an active account's role, suspend/restore an account, or review a pending request (admin only) |

Protected routes require a valid signed session or bearer token; authorization checks the current account status and role against each route. Supported roles are `facility_user`, `health_worker`, `cold_chain_officer`, `operations_manager`, and `admin`. There is no demo bypass. Health routes are public. Existing database accounts and configured `API_USERS` entries using retired role names are mapped to the corresponding consolidated role at startup.

The password endpoint returns `202 Accepted` with a short-lived HttpOnly pre-authentication cookie. First-time users call the MFA setup route and confirm a six-digit authenticator code; returning users verify a TOTP or one-time recovery code. Authentication is rate limited to twelve combined password, enrollment, and MFA attempts per account and IP address, plus 60 attempts per IP address, in a 15-minute window. A successful first enrollment returns ten recovery codes once; keep them private. Rotating `JWT_SECRET` requires MFA re-enrollment because it also protects encrypted TOTP secrets.

The public root, `/index.html`, and `/workspace` serve the application only after password and MFA verification; unauthenticated visitors are sent to `/auth.html`. Successful verification sets a one-hour `HttpOnly`, `SameSite=Strict` cookie (and `Secure` when `NODE_ENV=production`); API clients may also use the resulting bearer token.

Registration is enabled only when server-side JWT authentication, a trusted bootstrap administrator, and secure account storage are configured. Requests include the staff member's full name, work email, facility, staff/employee ID, one of the supported facility requester, health worker, cold-chain/logistics officer, or operations/warehouse manager job categories, and password. The server generates an internal account identifier, so registrants do not choose a username. Registered staff sign in with their work email; configured and legacy accounts can continue using usernames. Duplicate work emails and staff IDs are rejected. New accounts are immediately active with the restricted `facility_user` role, regardless of the selected job category. This role can view stock and submit or track only its own requisitions; it cannot access resident records, shipment telemetry, or reviewer controls. Administrators must verify staff details and change an account to a suitable operational role using `{"action":"SET_ROLE","role":"health_worker"}`. The registration request cannot grant the requested category's role or create an administrator. Administrator accounts must be provisioned as trusted bootstrap users in `API_USERS`. Existing pending requests created before this change can still be approved or rejected by an administrator. Passwords are stored as salted scrypt hashes in the application database; TOTP secrets are encrypted at rest and recovery codes are stored as hashes. Work-email collection does not itself verify identity.

### Role permissions

| Role | Primary permissions |
|---|---|
| `facility_user` | Stock read-only and own clinic requisitions; no clinical registry, telemetry, or review controls |
| `health_worker` | Vaccination registry, dashboard, resident records, notifications, own requisitions, and stock read-only |
| `cold_chain_officer` | Read shipment telemetry, submit readings for registered batches, and run shipment risk assessments; cannot change safe ranges or reserve inventory |
| `operations_manager` | Shared requisitions and status review, stock read access/reservations, and shipment/risk visibility |
| `admin` | Read-only requisitions, telemetry, stock, risk and service health; manage staff roles and suspend/restore accounts; cannot create operational transactions or access resident records |

Workspace navigation is filtered by role, and the gateway independently enforces API authorization. Facility-user and health-worker requisition lists and individual request lookups are restricted to the authenticated submitter. Operations managers can view the shared queue and update request status; stock reservations are limited to operations managers. Administrators have read-only access to operational service routes, while staff-account administration is handled by the separate admin endpoints. Role changes and suspensions invalidate existing sessions immediately. Administrator accounts cannot be reassigned or suspended through staff management.

An administrator can suspend or restore a self-registered account:

```json
{"action":"SUSPEND"}
```

Use `{"action":"ACTIVATE"}` to restore a suspended account. A suspended account cannot sign in and its active sessions are rejected. The account remains listed for audit and later restoration.

## Clinic Requisition Service

| Method | Route | Input | Success |
|---|---|---|---|
| `GET` | `/api/v1/requisitions/health` | None | `200` service status |
| `GET` | `/api/v1/requisitions` | None | `200` shared reviewer queue, or the signed-in health worker's own requests |
| `GET` | `/api/v1/requisitions/{id}` | Requisition ID | `200` request; health workers can view only their own |
| `POST` | `/api/v1/requisitions` | JSON request | `201` created request |
| `PUT` / `PATCH` | `/api/v1/requisitions/{id}/status` | Status; optional `vaccineId` for batch assignment | `200` updated request |

Example creation request:

```json
{
  "clinicId": "RHU-0101",
  "vaccineType": "Pentavalent (DPT-HepB-Hib)",
  "quantity": 50,
  "vaccineId": "VAX-1001",
  "telemetryFormat": "json"
}
```

`clinicId`, `vaccineType`, and positive integer `quantity` are required. `vaccineId` is optional. Without an assigned batch the request remains `PENDING`. If a batch is supplied during creation, `telemetryFormat` may be `json` (default) or `xml`; the service requests that format from the Telemetry Service over HTTP. It approves only a matching batch with `coldChainStatus: "OK"`. A mismatch returns `409 BATCH_VACCINE_MISMATCH`; a breach is recorded as `REJECTED` and returns `409 COLD_CHAIN_BREACH`; an unknown batch returns `404`; an unavailable telemetry service returns `503` without creating an approval.

The gateway records the verified account name as the request submitter. Health workers see the request's current status and submission time in their portal; existing records created before submitter tracking are visible only to reviewer/admin roles.

An authorized reviewer can assign and verify a batch while approving a pending request:

```json
{"status":"APPROVED","vaccineId":"VAX-1003"}
```

The service checks that the batch exists, matches the request's vaccine type, and has a clear cold-chain status before persisting either the assignment or approval. A mismatch, breach, or unavailable telemetry leaves the requisition unchanged. Requests without a batch cannot be approved. Reviewers may also set `HOLD` or `REJECTED`.

## Vaccine Cold-Chain Telemetry Service

| Method | Route | Input | Success |
|---|---|---|---|
| `GET` | `/api/v1/telemetry/health` | None | `200` service status |
| `GET` | `/api/v1/telemetry` | None | `200` current batch list |
| `GET` | `/api/v1/telemetry/alerts` | None | `200` current breach list |
| `GET` | `/api/v1/telemetry/{vaccineId}` | `Accept: application/json` or `application/xml` | `200` same resource in the negotiated representation |
| `GET` | `/api/v1/telemetry/{vaccineId}/history` | None | `200` stored reading history |
| `POST` | `/api/v1/telemetry` | JSON or XML telemetry reading | `201` stored reading |

JSON telemetry request:

```json
{
  "vaccineId": "VAX-1001",
  "vaccineName": "Pentavalent (DPT-HepB-Hib)",
  "currentTempCelsius": 4.2,
  "safeRangeCelsius": { "min": 2, "max": 8 },
  "humidityPercent": 60,
  "shipmentId": "SHIP-2026-014",
  "latitude": 14.5995,
  "longitude": 120.9842,
  "lastCheckedAt": "2026-10-26T07:00:00.000Z"
}
```

For a new batch, `vaccineId`, `vaccineName`, `currentTempCelsius`, and safe-range `min`/`max` are required. An existing batch's name and safe range cannot be changed by a reading. Transit loggers can submit readings only for existing batches and cannot create batches or change thresholds. Optional humidity and coordinates are range-validated. Each accepted reading updates the current value and appends an immutable history record.

The batch status is fail-safe: once a reading is outside its inclusive safe range, `coldChainStatus` stays `BREACH` even if a later reading returns to range. History preserves each reading's own status. There is no automated breach reset; a production workflow would require an authorized, audited safety review.

Telemetry `GET` responses use `Accept` to negotiate JSON or XML. XML ingestion accepts `Content-Type: application/xml` or `text/xml`; DTD/entity declarations are rejected. Standalone JSON/XML telemetry examples are in `docs/examples/`.

## Legacy inventory and SOAP mediation

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/stock/health` | Adapter health |
| `GET` | `/api/v1/stock/warehouse/{warehouseCode}` | Return legacy warehouse inventory as JSON |
| `GET` | `/api/v1/stock/sync/{vaccineId}` | Return one legacy inventory batch as JSON |
| `POST` | `/api/v1/stock/reserve` | Reserve stock through SOAP |
| `GET` | `/api/v1/stock/wsdl` | Gateway-proxied simulated HIS WSDL |

Reservation request:

```json
{"vaccineId":"VAX-1001","quantity":5}
```

The adapter translates REST/JSON to SOAP/XML, calls the simulated HIS, and translates its response or SOAP fault to JSON and an appropriate HTTP status. The SOAP simulator exposes its WSDL and `/soap` endpoint on its internal service port. Example envelopes are in `docs/examples/legacy-soap-request.xml` and `docs/examples/legacy-soap-response.xml`. This is a legacy-service simulator, not a connection to a real hospital inventory.

## Weather and shipment risk mashup

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/risk-assessment/health` | Mashup service health |
| `GET` | `/api/v1/risk-assessment/shipment/{shipmentId}` | Combine telemetry, legacy stock, and external weather |

The mashup uses Open-Meteo current weather at the recorded shipment coordinates and briefly caches successful responses. Its result includes each source's status and the rule explanations. Missing/stale telemetry, unavailable weather, missing inventory, or expired inventory yields `INSUFFICIENT_DATA`; it must not be interpreted as safe. The assessment score is a demonstration rule and is not clinical or vaccine-safety guidance.

## Service integration flow

1. A client submits a requisition to the gateway.
2. The gateway checks role access, adds or propagates a correlation ID, and routes the request.
3. The Requisition Service requests the assigned batch from Telemetry over HTTP in JSON or XML.
4. The service checks vaccine type and cold-chain status before approval and persistence.
5. For inventory, the REST adapter sends a SOAP/XML request to the simulated legacy HIS and transforms its response to JSON.
6. The risk mashup requests telemetry and inventory, retrieves external weather, and reports an explainable combined assessment.

Upstream errors fail closed: the system does not approve a requisition or report a complete risk result when a required source is unavailable.

## Error handling

| HTTP | Error code | Meaning |
|---|---|---|
| `400` | `MALFORMED_PAYLOAD`, `MISSING_REQUIRED_FIELD`, `INVALID_FORMAT`, `INVALID_ENUM` | Invalid JSON/XML or field values |
| `401` | `AUTH_MISSING_OR_EXPIRED`, `UNAUTHORIZED` | Missing/expired JWT or invalid login |
| `403` | `FORBIDDEN`, `CORS_ORIGIN_DENIED` | Role or origin is not permitted |
| `404` | `RESOURCE_NOT_FOUND` | Unknown route, batch, or requisition |
| `409` | `COLD_CHAIN_BREACH`, `BATCH_VACCINE_MISMATCH`, `BATCH_REQUIRED`, `INSUFFICIENT_STOCK` | Business rule prevents the requested action |
| `413` | `PAYLOAD_TOO_LARGE` | Request body exceeds configured limit |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Unsupported request content type |
| `429` | `RATE_LIMITED` | Gateway rate limit exceeded |
| `502` | `UPSTREAM_ERROR` | Downstream returned an invalid response |
| `503` | `SERVICE_UNAVAILABLE` | Required service is unavailable or remote authentication is not configured |

## Local examples

Use `http://127.0.0.1:3000` as the API Gateway base URL:

```powershell
curl.exe -H "Accept: application/xml" http://127.0.0.1:3000/api/v1/telemetry/VAX-1001
curl.exe -H "Content-Type: application/json" -d "{\"clinicId\":\"RHU-0101\",\"vaccineType\":\"Measles\",\"quantity\":20,\"vaccineId\":\"VAX-1002\"}" http://127.0.0.1:3000/api/v1/requisitions
curl.exe http://127.0.0.1:3000/api/v1/stock/warehouse/WAREHOUSE-MNL
curl.exe http://127.0.0.1:3000/api/v1/risk-assessment/shipment/SHIP-1001
```

The second example intentionally returns `409 COLD_CHAIN_BREACH`; VAX-1002 is a seeded breached demonstration batch.
