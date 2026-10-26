# Minimum Assignment Requirements Traceability

This matrix maps the 17 minimum functional and technical requirements in the assignment brief to the current repository. “Implemented locally” means the feature can be exercised with the application and tests on a developer machine; it does not imply a verified public-health deployment or regulatory approval.

| # | Requirement | Evidence in this repository | Current status / remaining evidence |
|---|---|---|---|
| 1 | Working client application | Browser vaccination tracker and operations portal in `index.html`, `app.js`, and `integration-ui.js`; resident dose/status/reminder tools connect to role-aware requisition, telemetry, inventory, risk, staff-account, and service-health workflows | Implemented locally; use the local account seeder to provision test logins and demonstrate each role |
| 2 | At least three distinct backend services | Requisition REST service, cold-chain telemetry REST service, legacy HIS REST-to-SOAP adapter, SOAP HIS simulator, and risk mashup service | Implemented locally; services have separate contracts and ports |
| 3 | API gateway or equivalent | `server.js` routes gateway requests to the backend services and applies common authentication, authorization, rate limits, CORS, and correlation IDs | Implemented locally |
| 4 | At least two service-to-service integrations | Requisition service verifies batches over HTTP with telemetry; mashup calls telemetry and the legacy adapter; adapter calls SOAP HIS | Implemented locally and covered by integration tests |
| 5 | RESTful API | Versioned gateway routes under `/api/v1`, status codes, validation, structured errors, and documented contracts in `docs/api.md` | Implemented locally |
| 6 | JSON data exchange | Gateway and REST services serialize/deserialize JSON for requisitions, telemetry, stock, and risk assessments | Implemented locally and tested |
| 7 | XML data exchange | Telemetry accepts and returns XML; SOAP adapter consumes and emits SOAP/XML | Implemented locally; sample payloads are included in `docs/examples/` |
| 8 | SOAP or legacy-service integration | Simulated SOAP HIS and REST-to-SOAP adapter in `services/legacy.js`; WSDL endpoint and SOAP faults | Implemented locally and covered by integration tests; simulator is not a real hospital system |
| 9 | External REST API | Risk mashup uses Open-Meteo current weather data with a bounded cache and injectable provider | Implemented; tests use an injected provider and do not load-test the public API |
| 10 | Mashup / combined response | Risk assessment combines shipment telemetry, legacy stock, and external weather; missing or stale sources yield `INSUFFICIENT_DATA` | Implemented locally and tested |
| 11 | Authentication and authorization | Sign-in landing page, protected workspace, password plus required authenticator-app MFA, encrypted TOTP secrets, one-use recovery codes, role-based page/API access, self-registration with least-privilege default role, administrator-controlled role assignment and suspension, salted scrypt passwords, and remote-bind startup checks | Implemented and tested; self-registered accounts start active as restricted facility users and can be elevated only by an administrator after staff details are verified; each account must enroll MFA before full sign-in |
| 12 | Functional and integration testing | `npm test`, including positive/negative cases, persistence, service integrations, provider outage, role access, and static UI; Postman collection in `postman/` | Implemented locally; run the suite and capture Postman results for submission |
| 13 | Load and/or stress testing | `scripts/loadtest.js` runs stepped concurrency profiles, reports throughput and latency percentiles, and restricts target URLs to loopback | Runnable equivalent and automated smoke test included; instructor approval of the equivalent tool and a recorded representative run/interpretation remain required |
| 14 | Cloud-based deployment | `Dockerfile` and `docs/railway-deployment.md` prepare a container and persistent Railway volume | Deployment package is prepared, but no live hosted deployment has been created or verified; requires the team's Railway account, configured users, and instructor-demo verification |
| 15 | Version control | The complete source and deployment configuration are maintained in this Git repository | Repository is present; meaningful team commits and individual contribution evidence must be provided by the project team |
| 16 | CI/CD | `.github/workflows/ci.yml` installs dependencies, tests, and builds the container; Railway connects to GitHub for deployment | Workflow is implemented; a successful GitHub Actions run and a verified Railway deployment remain external tasks |
| 17 | Middleware / EAI evidence | Gateway routing, JSON/XML transformations, SOAP mediation, service orchestration, correlation propagation, and the multi-source mashup | Implemented locally; explain the flows using `README.md` and `docs/api.md` |

## Local sample data and deployment limitations

- The local service topology uses seeded SQLite data, a simulated SOAP HIS, and a single Node.js process hosting distinct HTTP services.
- Railway persistent-volume setup, hosted account variables, deployment URL, and submission evidence still require the team's Railway account and instructor-demo verification.
- The load-test utility refuses non-loopback targets. Do not aim it at Open-Meteo or any public service; collect a run against the local requisition or telemetry service instead.
- Do not use real patient information, production inventory, or the risk score for clinical or vaccine-safety decisions. The current system has not undergone health-data security, regulatory, or clinical validation.
