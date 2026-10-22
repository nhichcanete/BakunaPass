import 'dotenv/config';
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

export function createServer({ sendEmail = sendSmtpEmail, sendSms = sendTwilioSms } = {}) {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      return jsonResponse(response, 200, { status: 'ok' });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/notifications') {
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