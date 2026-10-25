# BakunaPass

A lightweight vaccination status tracker for reviewing who is fully immunized, due for a booster, or still pending a second dose.

## Features

- Add a person's vaccine details
- Track dose count and most recent dose date
- Detect booster eligibility after 180 days
- Show clear pass validity status for each record
- Send editable email notifications (SMS supported by the backend)

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Run the app

Install dependencies, configure at least one delivery provider, and start the app and backend together:

```bash
npm install
npm start
```

Then visit `http://localhost:3000`. Do not open `index.html` directly; notification sending requires the backend.

### Configure email and SMS

Copy `.env.example` to `.env` and fill in the credentials for the provider(s) you want to use. Email uses SMTP; SMS uses Twilio. Never commit `.env` or put provider credentials in browser code.

For Gmail SMTP, the settings are typically:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-google-app-password
NOTIFICATION_FROM=your-address@gmail.com
```

Use a Google App Password for `SMTP_PASS` (not your normal Google password); Google requires 2-Step Verification to create one. Other email providers have their own SMTP host, port, and security settings. For email, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `NOTIFICATION_FROM`.

The Patient notifications section lets you choose a patient, then opens a message pop-out with the recipient, subject, and suggested message filled in. Review or edit those details before sending. Pressing **Send email** posts the edited values to the app's backend, which sends them through the configured SMTP provider as a styled HTML email with a plain-text fallback. The greeting name is bolded and recognized vaccination statuses and follow-up phrases are highlighted. The email address saved in the resident record is prefilled, and can be changed for that message. For SMS, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`; provider accounts may require sender verification and SMS may incur charges.

Without provider credentials, the app still starts, but sending returns a configuration error instead of pretending the message was delivered.

### Protect the notification endpoint

`POST /api/notifications` sends real email and SMS through your accounts, so it is locked down by default:

- **No token set (default):** only requests from the same machine are accepted.
- **`NOTIFICATION_API_TOKEN` set:** requests must send `Authorization: Bearer <token>`. Use this whenever the app is reachable from other devices. The notification form has an "Access token" field for it (kept in the browser session only).
- **Rate limit:** `NOTIFICATION_RATE_LIMIT` requests per minute per IP address (default 10).

## Run tests

```bash
npm test
```
