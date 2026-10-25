import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import twilio from 'twilio';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const maxBodySize = 16 * 1024;
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const publicFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/vaccination.js', 'vaccination.js'],
  ['/styles.css', 'styles.css'],
]);

function jsonResponse(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// With no token configured, only the local machine may send notifications.
function isAuthorized(request, apiToken) {
  if (!apiToken) {
    return loopbackAddresses.has(request.socket.remoteAddress);
  }

  const header = String(request.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(provided), hash(apiToken));
}

function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
    const allowed = recent.length < limit;
    if (allowed) {
      recent.push(now);
    }
    hits.set(key, recent);
    return allowed;
  };
}

async function readJsonBody(request) {
  let body = '';

  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodySize) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function validateNotification(payload) {
  const channel = payload?.channel;
  const target = String(payload?.to || '').trim();
  const subject = String(payload?.subject || 'BakunaPass Health Notification').trim();
  const message = String(payload?.message || '').trim();

  if (!['email', 'sms'].includes(channel)) {
    return { error: 'Channel must be email or sms.' };
  }

  if (!message || message.length > 4000) {
    return { error: 'Message is required and must be 4000 characters or fewer.' };
  }

  if (channel === 'email' && (!/^\S+@\S+\.\S+$/.test(target) || subject.length > 120)) {
    return { error: 'A valid email address and subject of 120 characters or fewer are required.' };
  }

  if (channel === 'sms' && !/^\+?[0-9()\s.-]{7,20}$/.test(target)) {
    return { error: 'A valid phone number is required for SMS.' };
  }

  return { channel, target, subject, message };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function createNotificationHtml({ subject, message }) {
  const safeSubject = escapeHtml(subject);
  const emphasisPattern = /^Dear\s+([^,\r\n]+),|booster review is now due|booster window has passed|booster due|booster complete|fully vaccinated|partially vaccinated|not vaccinated|complete(?:d)?(?: your)? (?:second )?dose|second dose is still needed|your dose is complete/gi;
  let formattedMessage = '';
  let previousIndex = 0;

  for (const match of message.matchAll(emphasisPattern)) {
    const beforeMatch = message.slice(previousIndex, match.index);
    formattedMessage += escapeHtml(beforeMatch).replace(/\r?\n/g, '<br>');

    if (match[1]) {
      formattedMessage += `Dear <strong>${escapeHtml(match[1])}</strong>,`;
    } else {
      formattedMessage += `<strong style="padding:1px 5px;border-radius:3px;background-color:#fff1d6;color:#80520b;">${escapeHtml(match[0])}</strong>`;
    }
    previousIndex = match.index + match[0].length;
  }

  formattedMessage += escapeHtml(message.slice(previousIndex)).replace(/\r?\n/g, '<br>');

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f3f5f7;font-family:Arial,Helvetica,sans-serif;color:#17232d;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f3f5f7;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e0e2e1;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;background-color:#173b5e;border-bottom:4px solid #bd7045;">
                <p style="margin:0 0 5px;color:#dce7ef;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Community health registry</p>
                <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.3;">BakunaPass</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 32px 24px;">
                <h2 style="margin:0 0 18px;color:#173b5e;font-size:20px;line-height:1.35;">${safeSubject}</h2>
                <div style="font-size:15px;line-height:1.75;color:#35444d;">${formattedMessage}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #e0e2e1;background-color:#faf7f3;color:#62717b;font-size:12px;line-height:1.5;">
                This message was sent by your community vaccination registry. Please contact your local health center if you have questions.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendSmtpEmail({ target, subject, message }) {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'NOTIFICATION_FROM'];
  if (required.some((key) => !process.env[key])) {
    const error = new Error('Email is not configured. Set the SMTP values in your .env file.');
    error.statusCode = 503;
    throw error;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: process.env.NOTIFICATION_FROM,
    to: target,
    subject,
    text: message,
    html: createNotificationHtml({ subject, message }),
  });
}

async function sendTwilioSms({ target, message }) {
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
  if (required.some((key) => !process.env[key])) {
    const error = new Error('SMS is not configured. Set the Twilio values in your .env file.');
    error.statusCode = 503;
    throw error;
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    body: message,
    from: process.env.TWILIO_FROM_NUMBER,
    to: target,
  });
}

export function createServer({
  sendEmail = sendSmtpEmail,
  sendSms = sendTwilioSms,
  apiToken = process.env.NOTIFICATION_API_TOKEN,
  rateLimit = { limit: Number(process.env.NOTIFICATION_RATE_LIMIT || 10), windowMs: 60_000 },
} = {}) {
  const allowRequest = createRateLimiter(rateLimit);

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      return jsonResponse(response, 200, { status: 'ok' });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/notifications') {
      if (!isAuthorized(request, apiToken)) {
        return jsonResponse(response, 401, {
          error: apiToken
            ? 'A valid access token is required to send notifications.'
            : 'Notifications can only be sent from this machine unless NOTIFICATION_API_TOKEN is set.',
        });
      }

      if (!allowRequest(request.socket.remoteAddress)) {
        return jsonResponse(response, 429, { error: 'Too many notification requests. Please wait a minute and try again.' });
      }

      try {
        const payload = await readJsonBody(request);
        const notification = validateNotification(payload);
        if (notification.error) {
          return jsonResponse(response, 400, { error: notification.error });
        }

        if (notification.channel === 'email') {
          await sendEmail(notification);
        } else {
          await sendSms(notification);
        }

        return jsonResponse(response, 200, { sent: true, channel: notification.channel });
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const message = statusCode === 502
          ? 'The delivery provider could not send the notification. Check its configuration and try again.'
          : error.message;
        return jsonResponse(response, statusCode, { error: message });
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(response, 405, { error: 'Method not allowed.' });
    }

    const publicFile = publicFiles.get(requestUrl.pathname);
    if (!publicFile) {
      return jsonResponse(response, 404, { error: 'Not found.' });
    }

    const filePath = path.join(projectDirectory, publicFile);

    try {
      const contents = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch {
      jsonResponse(response, 404, { error: 'Not found.' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const port = Number(process.env.PORT || 3000);

  server.listen(port, () => {
    console.log(`BakunaPass is running at http://localhost:${port}`);
  });
}