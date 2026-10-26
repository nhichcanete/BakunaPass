# BakunaPass

BakunaPass connects rural health unit (RHU) vaccine requisitions with cold-chain shipment telemetry, legacy warehouse inventory, and community vaccination follow-up in one role-controlled health operations portal.

Its goal is to give authorized clinic, cold-chain, warehouse, and public-health staff a shared view of vaccine requests and shipment conditions, while keeping staff permissions separated. The supplied batch and inventory records are sample operational data, not live stock, medical advice, or regulatory guidance. BakunaPass is not an official Department of Health service.

## Project overview

The system addresses fragmented vaccine requisition and cold-chain records through several backend services:

- **Clinic Requisition Service** (`5001`): receives and tracks clinic vaccine requisitions. When a batch is assigned, it calls the telemetry service over HTTP and approves only a matching batch with a clear cold-chain status. Breached batches are rejected with `409 Conflict`; missing/unavailable telemetry never results in approval.
- **Vaccine Cold-Chain Telemetry Service** (`5002`): ingests validated readings, computes whether the reading is inside the submitted safe range, and returns current batch data and reading history as JSON or XML.
- **Legacy HIS REST-to-SOAP Adapter** (`5003`) and **simulated SOAP HIS** (`5004`): translate REST/JSON inventory reads and reservations to and from legacy SOAP/XML.
- **Shipment Risk Mashup** (`5005`): combines telemetry, legacy warehouse inventory, and Open-Meteo weather into an explainable assessment. Missing, stale, or unavailable inputs remain visibly incomplete rather than being reported as safe.
- **API Gateway** (`3000`): provides a single client entry point, routes requests to the services, adds correlation IDs, applies rate limits and role checks, and returns consistent errors.

The services use separate ports and responsibilities but run in one Node.js process and share a local SQLite database. The supplied VAX-1001/1002/1003 batches support the JSON, XML, SOAP, and breach workflows. Replace these sample records and connect approved health-system integrations before operational use.

### Architecture and integration

```text
API clients / Postman
                 |
                 | HTTPS in a real deployment; JSON or XML
                 v
       API Gateway :3000
        |           |
        |           +----> Telemetry Service :5002 ----> SQLite
        |                      ^                         current batches
        |                      | HTTP JSON or XML       telemetry history
        +----> Requisition Service :5001
                         |
                         +---- HTTP GET /telemetry/{vaccineId}
                              Accept: application/json or application/xml
```

The gateway is the client-facing entry point. The requisition service calls telemetry directly over HTTP; the inventory adapter calls the SOAP HIS; and the mashup orchestrates telemetry, stock, and external weather data. A pending requisition can be assigned a registered batch by an authorized reviewer; the service checks that its vaccine type matches and verifies cold-chain status before approval. See [docs/api.md](docs/api.md) for the full API contract.

## Requirements covered by this implementation

- Distinct REST requisition, telemetry, inventory-adapter, and risk-mashup services, plus a simulated SOAP HIS.
- Telemetry `GET /telemetry/{vaccineId}` content negotiation using the `Accept` header (`application/json` or `application/xml`).
- JSON and XML telemetry ingestion; malformed payload, missing field, unsupported media type, and unknown-resource errors.
- HTTP requisition-to-telemetry integration using both JSON and XML responses; clear batches are approved and breached batches rejected.
- Fail-safe latched batch breach status and immutable safe-range policy for existing batches; sensor-role credentials cannot edit range rules.
- Central gateway routing, per-request correlation IDs, in-memory rate limiting, and mandatory JWT authentication/RBAC.
- SQLite persistence for staff accounts, telemetry, reading history, requisitions, and sample inventory.
- Staff self-registration with limited default access, administrator-managed role assignment, required authenticator-app MFA, one-time recovery codes, and role-filtered workspace navigation.
- Open-Meteo mashup, Railway-ready Docker deployment, GitHub CI workflow, and a loopback-only load-test utility.
- Automated tests and an importable Postman collection for health, JSON/XML, SOAP mediation, mashup, validation, authorization, and service integration.
- API, data representation, integration flow, error, setup, and testing documentation in this README and [docs/api.md](docs/api.md).

## Installation and execution

Requires Node.js 22.13 or newer. The project uses the built-in `node:sqlite` module; no additional database package is required.

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm start
```

The gateway is at `http://127.0.0.1:3000`; its public landing page is the sign-in screen. The private dashboard is available at `/workspace` only after authentication. Service ports `5001` and `5002` bind to loopback and should not be exposed directly to clients. The app creates `data/bakunapass.sqlite` on first start; this local database directory is ignored by Git.

Default settings intentionally bind the gateway to loopback. For an approved hosted environment, use TLS, configure a strong `JWT_SECRET` and trusted bootstrap accounts in `API_USERS`, set a specific `CORS_ORIGIN` only if needed, and restrict service ports to the private network. Do not expose the internal service ports or enter real patient data. The in-memory rate limiter, browser-local vaccination registry, sample inventory, and SQLite deployment are single-instance choices; they are not substitutes for a health-system identity provider, shared clinical record service, or regulated production infrastructure.

Resident vaccination entries are currently stored in the signed-in health worker's browser, scoped by username. They do not synchronize between staff devices and are not centrally backed up; use only non-identifying sample data until an approved server-side clinical registry is integrated.

### Authentication, two-factor verification, and role-based access

Configure a unique `JWT_SECRET` and real accounts in `API_USERS` (JSON array) before sign-in or registration can be used:

```dotenv
JWT_SECRET=replace-with-a-long-random-secret
API_USERS=[{"username":"bootstrap-admin","password":"replace-this-with-a-unique-strong-password","role":"admin"},{"username":"facility-user","password":"replace-this-with-a-unique-strong-password","role":"facility_user"},{"username":"rhu-worker","password":"replace-this-with-a-unique-strong-password","role":"health_worker"},{"username":"cold-chain","password":"replace-this-with-a-unique-strong-password","role":"cold_chain_officer"},{"username":"operations-manager","password":"replace-this-with-a-unique-strong-password","role":"operations_manager"}]
```

Use unique strong passwords and a secret manager for deployed environments. A valid password begins a five-minute MFA enrollment or challenge; it does not issue a full session. Each staff member must enroll an authenticator app using the displayed setup key or `otpauth` link. Subsequent sign-ins require a current six-digit TOTP code or a one-time recovery code. The server encrypts authenticator secrets with AES-GCM using a key derived from `JWT_SECRET`, stores recovery-code hashes, prevents reusing a TOTP step, and sets a one-hour `HttpOnly`, `SameSite=Strict` session cookie (`Secure` in production). Save the ten recovery codes during enrollment; they are shown once. Rotating `JWT_SECRET` requires staff to enroll MFA again.

Self-registration collects full name, work email, facility, staff/employee ID, a job category from the supported facility requester, health worker, cold-chain/logistics officer, or operations/warehouse manager list, and password; staff do not choose a username. The category records the applicant's job/access request but does not grant that role. Every new account starts as `facility_user`, the least-privilege role: it can view stock and submit or track only its own clinic requisitions. It cannot view resident records, shipment telemetry, or other facilities' requests. Sign in with the registered work email and password; existing accounts can continue using their username. Administrators must verify the person's staff details and assign any elevated role from staff-account management; administrator accounts are provisioned separately. Work-email collection does not itself verify identity, so use this flow only for staff onboarding and configure organization email/identity verification before public exposure.

The public landing page is `/auth.html` (`/auth` and `/login` are aliases). `/`, `/index.html`, and `/workspace` serve the application only after MFA-completed sign-in. The presentation describes the resident vaccination-status tracker: the existing status engine, resident registry, reminders, search/filter, coverage chart, CSV export, and print view remain part of the client. BakunaPass extends that workflow with staff accounts, role-gated operations, requisitions, inventory, cold-chain services, a SOAP adapter, and a weather risk mashup. The role controls both visible workspace pages and API access:

| Role | Workspace pages and permissions |
|---|---|
| `facility_user` | Read-only stock view and own clinic requisitions; no resident registry or operational controls |
| `health_worker` | Vaccination registry, dashboard, resident records, notifications, own requisitions, and stock read-only |
| `cold_chain_officer` | Shipment telemetry, registered-batch temperature readings, and shipment risk assessment |
| `operations_manager` | Shared requisitions and status review, stock read access and reservations, and shipment/risk visibility |
| `admin` | Read-only operational dashboards, downstream service health, and staff account role/suspension management; cannot create operational transactions or access resident records |

Facility users and health workers can only see requisitions submitted under their account. Requisition approval requires a matching registered batch with a clear cold-chain status. Cold-chain officers can submit readings only for registered batches and cannot change temperature safety ranges; operations managers can view but not submit readings. Administrators can suspend or restore self-registered accounts; suspended accounts cannot sign in and existing sessions are rejected immediately. Administrator accounts themselves cannot be changed through staff role management. Role changes take effect immediately for existing sessions. Roles are checked at the gateway; hiding a page in the browser is not the authorization boundary. Existing accounts in the SQLite database are migrated from the retired roles; legacy `API_USERS` role values are also mapped automatically (`clinic_supervisor`, `pho_admin`, and `warehouse_manager` become `operations_manager`; `transit_logger` becomes `cold_chain_officer`).

For local role walkthrough accounts, run `npm run seed:accounts` once from a non-production loopback setup. It generates unique passwords and a signing secret in the ignored `.env` file, adds one account for each role, and prints the passwords once. Save them privately, restart BakunaPass, and complete MFA enrollment at first sign-in. Do not run this command in a hosted environment or commit/share `.env`; these are local test accounts, not production identities.

For a realistic demonstration, provision a distinct `API_USERS` account for each role you plan to show, including a separate administrator account. Give every account a unique password, enroll MFA for each, and use only test data. The sample usernames above are labels, not usable credentials; never publish shared passwords or commit real credentials.

The gateway rate limit defaults to 120 API requests per minute per client IP (`API_RATE_LIMIT`). It is in memory and resets when the process restarts. Configure `CORS_ORIGIN` to one exact trusted origin if cross-origin browser access is required; same-origin use does not require CORS. A live service needs organization-approved identity and email verification, a server-side clinical registry, audit and retention policies, secure backups, multi-instance rate limiting, health-data governance, and security/clinical validation. Do not use real patient information or rely on the informational risk assessment for vaccine-safety decisions.

The supplied presentation is a useful description of the original resident-tracker workflow, but its architecture and “limitations/next steps” slides predate the current extensions. Before presenting, update those slides to show the current gateway, staff roles/MFA, operational SQLite data, SOAP/XML integration, and weather mashup as implemented features. The resident vaccination registry remains browser-local; it is not yet a shared, server-backed clinical record.

### Optional email and SMS notifications

Copy `.env.example` and configure SMTP or Twilio only if you need the vaccination follow-up notification feature. Keep provider credentials out of source control. Email uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `NOTIFICATION_FROM`; SMS uses `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. Twilio is an optional SMS delivery provider for resident follow-up reminders; it is not used for login or MFA, which uses an authenticator app. The current workspace sends email notifications; SMS delivery is available through the backend API once Twilio is configured. Notification requests require a signed-in health-worker session when JWT authentication is enabled, may additionally require `NOTIFICATION_API_TOKEN`, and are rate limited.

Blank notification settings are intentional until a provider is selected: blank Twilio values mean SMS delivery is unavailable; a blank `NOTIFICATION_API_TOKEN` omits the optional extra bearer-token check (a health-worker session is still required when JWT is enabled; without JWT, requests are restricted to loopback). A blank `REQUISITION_TELEMETRY_URL` uses the local telemetry service default, and a blank `CORS_ORIGIN` is appropriate for same-origin use. Configure production secrets only in the hosting provider's secret manager.

Run `npm run email:verify` to verify SMTP connectivity and credentials without sending a message. The configured local Gmail SMTP connection passed this check. See [railway-deployment.md](docs/railway-deployment.md) for Railway setup and hosted SMTP verification steps.

## API and data representation

The gateway exposes versioned routes under `/api/v1` and direct aliases for the course examples:

| Method | Gateway route | Purpose |
|---|---|---|
| `GET` | `/api/v1/requisitions/health` | Requisition service health |
| `GET` | `/api/v1/requisitions` | List requisitions |
| `GET` | `/api/v1/requisitions/{id}` | Read a requisition |
| `POST` | `/api/v1/requisitions` | Create a request; optional `vaccineId` triggers telemetry verification |
| `PUT` / `PATCH` | `/api/v1/requisitions/{id}/status` | Hold, reject, or verify before approving |
| `GET` | `/api/v1/telemetry/health` | Telemetry service health |
| `GET` | `/api/v1/telemetry` | List current batch readings |
| `GET` | `/api/v1/telemetry/alerts` | List batches currently in breach |
| `GET` | `/api/v1/telemetry/{vaccineId}` | Read current status; negotiate JSON/XML with `Accept` |
| `GET` | `/api/v1/telemetry/{vaccineId}/history` | Read stored telemetry readings |
| `POST` | `/api/v1/telemetry` | Ingest a JSON or XML temperature reading |
| `POST` | `/api/v1/auth/token` | Exchange configured credentials for a JWT |
| `GET` | `/api/ready` | Check all backend services |
| `GET` | `/api/v1/stock/warehouse/{warehouseCode}` | Read stock through the REST-to-SOAP adapter |
| `POST` | `/api/v1/stock/reserve` | Reserve stock through the SOAP HIS |
| `GET` | `/api/v1/stock/wsdl` | Retrieve the legacy HIS WSDL through the adapter |
| `GET` | `/api/v1/risk-assessment/shipment/{shipmentId}` | Get the telemetry, inventory, and weather mashup |

The unversioned `/requisitions` and `/telemetry` routes are aliases for the same services. Details, field shapes, response codes, and examples are in [docs/api.md](docs/api.md), with standalone examples in [docs/examples/](docs/examples/).
The item-by-item trace to the PDF assignment is in [docs/requirements-matrix.md](docs/requirements-matrix.md).

## Container and cloud deployment

The repository includes a [Dockerfile](Dockerfile) and a detailed [Railway deployment guide](docs/railway-deployment.md). Railway is the selected host for the instructor demo. Follow the guide to prepare the GitHub repo, configure a persistent volume and secrets, deploy, and verify the hosted URL. This repository does **not** claim that a live cloud deployment has already been performed.

## Testing

Run all unit and API integration tests:

```powershell
npm test
```

The test runner ignores local `.env` authentication settings so seeded demo accounts do not affect test results.

Import [postman/BakunaPass.postman_collection.json](postman/BakunaPass.postman_collection.json) into Postman and set `baseUrl` to `http://127.0.0.1:3000`. Requests cover readiness, JSON/XML, SOAP WSDL mediation, stock transformation, risk mashup, validation, pending-batch review/approval, and service outages. If JWT is enabled, configure a login request using a reviewer/admin account to run the approval and inventory workflows and set its returned token as `accessToken`. The optional failure-simulation request is skipped unless `simulateTelemetryFailure` is set to `true`; for that test only, set `REQUISITION_TELEMETRY_URL=http://127.0.0.1:1` before restarting BakunaPass, then restore the normal configuration afterward.

For a loopback-only stepped load check, start the application and run `npm run load:test`. The default profile targets a telemetry batch read at concurrency levels 1, 5, and 10 for 10 seconds per stage. It reports request rate and latency percentiles and refuses non-local targets. For example, use `npm run load:test -- --url http://127.0.0.1:5001/requisitions --duration 30 --concurrency 1,10,20` for a different local profile. See [docs/load-test-results.md](docs/load-test-results.md) for a measured sample. Confirm the Node-based equivalent is accepted by the instructor.

The GitHub workflow at `.github/workflows/ci.yml` runs tests and builds the container on pushes to `main` and pull requests. Railway's GitHub integration can deploy pushed commits; check CI and deployment status before presenting. See [docs/railway-deployment.md](docs/railway-deployment.md) for setup and evidence requirements.

## Known scope limits

The SOAP HIS is simulated, weather is external and is not a medical-grade cold-chain forecast, the risk output is informational, and SQLite/in-memory rate limiting are single-instance choices. A hosted environment, recorded load/stress run, team contribution evidence, clinical validation, authoritative identity integration, and health-data governance still require project-team and instructor action. Never use real patient data or rely on the risk assessment for vaccine-safety decisions.
