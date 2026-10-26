# Deploy BakunaPass to Railway

This guide is for an instructor-facing demonstration with synthetic data, not a public-health production system. Railway hosting can incur charges; review current pricing before deploying.

## 1. Prepare the existing GitHub repository

The project is already connected to `Raven-hub-dev/BakunaPass` on the `main` branch. You do not need to create another repository. Keep the existing remote unless your instructor specifically wants the project moved to a different GitHub account.

In PowerShell, open the repository:

```powershell
Set-Location C:\Users\Rincho\BakunaPass
git status --short
git remote -v
```

Review the changes before staging. The local `.env` contains secrets and must remain ignored. Check this explicitly:

```powershell
git check-ignore -v .env
git status --short
```

Do not use `git add -f .env`, and do not paste `.env` contents into GitHub, Railway chat, or a commit. The repository ignores `.env`, `node_modules`, and local `data`.

After reviewing the files to publish, stage and inspect the changes:

```powershell
git add -A
git diff --cached --check
git diff --cached --stat
git status --short
```

Confirm `.env` is not staged. Then commit and push to the existing `main` branch:

```powershell
git commit -m "Prepare BakunaPass for instructor deployment"
git push origin main
```

If GitHub asks for authentication, use the browser sign-in flow or a GitHub credential manager; do not put a token in the command line. GitHub Actions runs tests and builds the Docker image after the push. Connect Railway only to the branch you intend to deploy, and push tested changes to it.

If you truly need a new repository instead, create an empty private repository on GitHub (do not initialize it with an extra README/license), then replace the existing remote only after confirming the destination with your team:

```powershell
git remote add deployment <your-new-GitHub-repository-URL>
git push -u deployment main
```

Do not do this for the existing class repository unless requested.

## 2. Create the Railway project

1. Sign in at [Railway](https://railway.com/) and connect the GitHub account that can access `Raven-hub-dev/BakunaPass`.
2. Create a project using **New Project → Deploy from GitHub Repo**, select `Raven-hub-dev/BakunaPass`, and select `main`.
3. Railway detects the root `Dockerfile`. Wait for the first build/deploy attempt; it may fail until the required variables below are added.
4. Review Railway's current plan and projected costs before enabling paid resources. Add a usage alert or spending control if available on the selected plan.

## 3. Attach persistent SQLite storage

1. Open the Railway service and add a volume.
2. Set its mount path to `/app/data`.
3. Add `DATABASE_PATH=/app/data/bakunapass.sqlite` to the service variables.
4. Add `RAILWAY_RUN_UID=0`. Railway mounts volumes as root; this setting allows this demo container to write to the attached volume despite its Dockerfile default user.

This app stores operational requisitions, telemetry, staff accounts, and MFA records in SQLite. Without the volume, those records can be lost when the container is replaced. The resident vaccination tracker itself remains browser-local.

## 4. Configure service variables and secrets

Open the Railway service's **Variables** page. Add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `SERVICE_HOST` | `127.0.0.1` |
| `DATABASE_PATH` | `/app/data/bakunapass.sqlite` |
| `RAILWAY_RUN_UID` | `0` |
| `JWT_SECRET` | Generate a new random secret with at least 32 bytes. Keep it private. |
| `API_USERS` | A JSON array of deployment-only accounts; examples below. |

Create new usernames and unique passwords for the hosted demo. Do not reuse or upload the local seeded accounts in `.env`. Every password must be at least 12 characters. Include an admin account and whichever operational roles you plan to present. For example, replace every placeholder before adding this value:

```json
[{"username":"demo-admin","password":"REPLACE_WITH_UNIQUE_16_CHAR_OR_LONGER_PASSWORD","role":"admin"},{"username":"demo-facility","password":"REPLACE_WITH_ANOTHER_UNIQUE_PASSWORD","role":"facility_user"},{"username":"demo-health-worker","password":"REPLACE_WITH_ANOTHER_UNIQUE_PASSWORD","role":"health_worker"},{"username":"demo-cold-chain","password":"REPLACE_WITH_ANOTHER_UNIQUE_PASSWORD","role":"cold_chain_officer"},{"username":"demo-operations","password":"REPLACE_WITH_ANOTHER_UNIQUE_PASSWORD","role":"operations_manager"}]
```

Use the Railway variable generator for `JWT_SECRET` if offered, or generate one locally without sharing it:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Store account passwords in your team's password manager. Changing `JWT_SECRET` later invalidates existing sessions and means staff must enroll MFA again. Keep `CORS_ORIGIN` blank for the normal same-origin hosted website. Do not put secrets in `README.md`, this guide, GitHub Actions logs, or screenshots.

## 5. Optional Gmail SMTP for email notifications

The local Gmail SMTP connection and credentials have passed a connection/authentication check, but no email has been sent. That does **not** prove Railway can connect to Gmail or that messages will be delivered.

If email is part of the demo:

1. Use a dedicated Gmail account controlled by your team, with 2-Step Verification enabled.
2. Create a Google [App Password](https://support.google.com/accounts/answer/185833). Do not use the account's normal password. Some managed school/work Google accounts may not allow App Passwords; if so, use an email API/provider approved by your instructor rather than weakening account security.
3. Add these in Railway **Variables**; set the password using the secret input:
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=587`
   - `SMTP_SECURE=false`
   - `SMTP_USER=<dedicated Gmail address>`
   - `SMTP_PASS=<Google App Password>`
   - `NOTIFICATION_FROM=<same Gmail address or a verified sender alias>`
4. Redeploy after adding variables. Sign in as the hosted `health_worker` account, create only a synthetic test reminder, and send it to an inbox a team member controls. Confirm receipt and inspect Railway logs if the provider rejects it.

To check SMTP connection/authentication without sending a message in an environment that has the variables loaded, run:

```powershell
npm run email:verify
```

Run this locally before deploying. The deployment UI test is still needed to prove actual Railway delivery. If Railway's network or Gmail account policy prevents SMTP, use an instructor-approved email provider with an HTTP API; this code currently uses SMTP and would need a small provider integration to use an HTTP-only service.

`NOTIFICATION_API_TOKEN` is optional. Leave it unset unless you specifically want an additional bearer-token check; role-based health-worker authentication is still enforced.

## 6. Deploy and generate the public demo URL

1. In Railway, trigger a deployment of the tested `main` commit.
2. In the service's **Settings → Networking**, generate a Railway public domain. Railway supplies HTTPS for the domain.
3. Configure Railway's health check path as `/api/ready` if it is not detected automatically. This endpoint checks that the gateway can reach its internal services.
4. Wait until the deployment is healthy and `/api/ready` reports `"status":"ready"` with all services `UP`.
5. Open the HTTPS domain, sign in with each demonstration account, enroll MFA, and verify role-specific pages and APIs. Save the ten MFA recovery codes securely; they are displayed once.
6. If presenting email, do the synthetic notification delivery test in the previous section.

Only the gateway should be public. Requisition, telemetry, SOAP, adapter, and mashup services bind to loopback inside the container; do not add public domains or TCP proxies for those ports.

## 7. Future updates and submission evidence

Railway can redeploy when new commits reach the connected branch. Inspect GitHub Actions and Railway deployment logs/status after each change. The included GitHub Actions workflow tests and builds the image; Railway's GitHub integration handles the deployment.

For the instructor, save:

- the Railway HTTPS URL;
- a successful GitHub Actions run;
- Railway's successful deployment and `/api/ready` status;
- role-by-role workflow results;
- email delivery evidence if that feature is demonstrated, with recipient address and secrets redacted.

Do not include `.env`, credentials, MFA setup keys, recovery codes, or real personal/health data in the submission. This setup is intended for an instructor demo with synthetic data; it is not a clinical production deployment.
