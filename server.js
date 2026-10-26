import 'dotenv/config';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import twilio from 'twilio';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  verifyTotpCode,
} from './mfa.js';
import { createServiceServer } from './api-services.js';
import { createStore } from './store.js';
import { createLegacyAdapterServer, createLegacySoapServer } from './services/legacy.js';
import { createMashupServer, createOpenMeteoProvider } from './services/mashup.js';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(crypto.scrypt);
const maxBodySize = 64 * 1024;
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const publicFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/favicon.svg', 'favicon.svg'],
  ['/auth', 'auth.html'],
  ['/auth.html', 'auth.html'],
  ['/login', 'auth.html'],
  ['/signin', 'auth.html'],
  ['/auth.js', 'auth.js'],
  ['/app.js', 'app.js'],
  ['/vaccination.js', 'vaccination.js'],
  ['/integration-ui.js', 'integration-ui.js'],
  ['/styles.css', 'styles.css'],
]);

function jsonResponse(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function apiError(response, statusCode, code, message, details, correlationId) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Correlation-ID': correlationId,
  });
  response.end(JSON.stringify({
    error: code,
    message,
    details,
    timestamp: new Date().toISOString(),
    correlationId,
  }));
}

function constantTimeEqual(first, second) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(first), hash(second));
}

function signAccessToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const content = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(content).digest('base64url');
  return `${content}.${signature}`;
}

function verifyAccessToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    return null;
  }
  const content = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(content).digest();
  let provided;
  let header;
  let payload;
  try {
    provided = Buffer.from(parts[2], 'base64url');
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  if (!payload.sub || !payload.role || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function loadApiUsers(configuredUsers) {
  if (configuredUsers) {
    const users = typeof configuredUsers === 'string' ? JSON.parse(configuredUsers) : configuredUsers;
    if (!Array.isArray(users)) {
      throw new TypeError('API_USERS must be a JSON array of username, password, and role objects.');
    }
    const usernames = new Set();
    const normalizedUsers = [];
    for (const user of users) {
      const normalizedUser = user && typeof user.role === 'string'
        ? { ...user, role: normalizeRole(user.role) }
        : user;
      if (!normalizedUser || typeof normalizedUser.username !== 'string' || !normalizedUser.username.trim()
        || typeof normalizedUser.password !== 'string' || normalizedUser.password.length < 12
        || !apiRoles.has(normalizedUser.role) || usernames.has(normalizedUser.username)) {
        throw new TypeError('Each API_USERS entry must have a unique username, a password of at least 12 characters, and a supported role.');
      }
      usernames.add(normalizedUser.username);
      normalizedUsers.push(normalizedUser);
    }
    return normalizedUsers;
  }
  if (!process.env.API_USERS) {
    return [];
  }
  return loadApiUsers(process.env.API_USERS);
}

function normalizeRole(role) {
  if (['clinic_supervisor', 'pho_admin', 'warehouse_manager'].includes(role)) {
    return 'operations_manager';
  }
  return role === 'transit_logger' ? 'cold_chain_officer' : role;
}

function getApiRole(request, secret, authStore, users) {
  if (!secret) return null;
  const header = String(request.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || getSessionCookie(request);
  const payload = verifyAccessToken(token, secret);
  if (payload?.mfa !== true) return null;
  const applicationUser = authStore?.findApplicationUser(payload.sub);
  if (applicationUser) {
    return applicationUser.status === 'ACTIVE' && applicationUser.role === payload.role
      ? payload.role
      : null;
  }
  const configuredUser = users.find((user) => user.username === payload.sub);
  return configuredUser?.role === payload.role ? payload.role : null;
}

function getApiUsername(request, secret) {
  if (!secret) {
    return null;
  }
  const header = String(request.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || getSessionCookie(request);
  const payload = verifyAccessToken(token, secret);
  return payload?.mfa === true ? payload.sub : null;
}

function getSessionCookie(request) {
  const cookies = String(request.headers.cookie || '').split(';');
  const sessionCookie = cookies.find((cookie) => cookie.trim().startsWith('bakunapass_session='));
  if (!sessionCookie) {
    return null;
  }
  try {
    return decodeURIComponent(sessionCookie.trim().slice('bakunapass_session='.length));
  } catch {
    return null;
  }
}

function sessionCookie(token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `bakunapass_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function mfaCookie(name, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(token)}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function getCookie(request, name) {
  const prefix = `${name}=`;
  const entry = String(request.headers.cookie || '').split(';').find((cookie) => cookie.trim().startsWith(prefix));
  if (!entry) {
    return null;
  }
  try {
    return decodeURIComponent(entry.trim().slice(prefix.length));
  } catch {
    return null;
  }
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code).replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

function makeAccessToken(username, role, jwtSecret) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return signAccessToken({ sub: username, role, mfa: true, exp: expiresAt }, jwtSecret);
}

function isLoopback(request) {
  return loopbackAddresses.has(request.socket.remoteAddress);
}

const apiRoles = new Set([
  'facility_user',
  'health_worker',
  'cold_chain_officer',
  'operations_manager',
  'admin',
]);
const registrationJobTitles = new Set([
  'Facility staff / vaccine requester',
  'Public health nurse / midwife',
  'Cold-chain / logistics officer',
  'Operations / warehouse manager',
]);

function canAccessApi(role, pathname, method) {
  const route = pathname.replace(/^\/api\/v1/, '');
  if (/^\/(?:health|requisitions\/health|telemetry\/health|stock\/health|risk-assessment\/health)$/.test(route)) {
    return true;
  }
  if (!apiRoles.has(role)) {
    return false;
  }
  if (route.startsWith('/requisitions')) {
    if (method === 'GET') {
      return ['facility_user', 'health_worker', 'operations_manager', 'admin'].includes(role);
    }
    if (route.endsWith('/status')) {
      return role === 'operations_manager';
    }
    return ['facility_user', 'health_worker'].includes(role);
  }
  if (route.startsWith('/telemetry')) {
    if (method === 'GET') {
      return ['cold_chain_officer', 'operations_manager', 'admin'].includes(role);
    }
    return role === 'cold_chain_officer';
  }
  if (route.startsWith('/stock')) {
    if (method === 'GET') {
      return ['facility_user', 'health_worker', 'operations_manager', 'admin'].includes(role);
    }
    return role === 'operations_manager';
  }
  if (route.startsWith('/risk-assessment')) {
    return method === 'GET' && ['cold_chain_officer', 'operations_manager', 'admin'].includes(role);
  }
  return false;
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

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodySize) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  serviceUrls = {
    requisitions: `http://127.0.0.1:${process.env.REQUISITION_SERVICE_PORT || 5001}`,
    telemetry: `http://127.0.0.1:${process.env.TELEMETRY_SERVICE_PORT || 5002}`,
    legacy: `http://127.0.0.1:${process.env.LEGACY_ADAPTER_PORT || 5003}`,
    mashup: `http://127.0.0.1:${process.env.MASHUP_SERVICE_PORT || 5005}`,
  },
  jwtSecret = process.env.JWT_SECRET,
  apiUsers = process.env.API_USERS,
  authStore,
  allowedOrigin = process.env.CORS_ORIGIN || '',
  apiRateLimit = { limit: Number(process.env.API_RATE_LIMIT || 120), windowMs: 60_000 },
} = {}) {
  if (jwtSecret && Buffer.byteLength(jwtSecret) < 32) {
    throw new TypeError('JWT_SECRET must contain at least 32 bytes.');
  }
  const allowRequest = createRateLimiter(rateLimit);
  const allowApiRequest = createRateLimiter(apiRateLimit);
  const allowAuthenticationAttempt = createRateLimiter({ limit: 12, windowMs: 15 * 60_000 });
  const allowAuthenticationIpAttempt = createRateLimiter({ limit: 60, windowMs: 15 * 60_000 });
  const users = loadApiUsers(apiUsers);
  const hasBootstrapAdmin = users.some((user) => user.role === 'admin');
  const mfaEncryptionKey = jwtSecret
    ? crypto.createHash('sha256').update(`bakunapass-totp:${jwtSecret}`).digest()
    : null;

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const correlationId = crypto.randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);
    const requestOrigin = String(request.headers.origin || '');
    if (requestOrigin && allowedOrigin && requestOrigin === allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      response.setHeader('Vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      const origin = String(request.headers.origin || '');
      if (origin && (!allowedOrigin || origin !== allowedOrigin)) {
        return apiError(response, 403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed.', {}, correlationId);
      }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Correlation-ID');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
      }
      response.writeHead(204);
      return response.end();
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      return jsonResponse(response, 200, { status: 'ok' });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/ready') {
      const serviceChecks = await Promise.all(Object.entries(serviceUrls).map(async ([serviceName, baseUrl]) => {
        try {
          const health = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(1000) });
          return { service: serviceName, status: health.ok ? 'UP' : 'DOWN' };
        } catch {
          return { service: serviceName, status: 'DOWN' };
        }
      }));
      const ready = serviceChecks.every(({ status }) => status === 'UP');
      return jsonResponse(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        services: serviceChecks,
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/auth/config') {
      return jsonResponse(response, 200, {
        loginEnabled: Boolean(jwtSecret && users.length),
        registrationEnabled: Boolean(jwtSecret && hasBootstrapAdmin && authStore),
        mfaRequired: true,
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/auth/session') {
      const role = getApiRole(request, jwtSecret, authStore, users);
      const username = getApiUsername(request, jwtSecret);
      if (!role) {
        return apiError(response, 401, 'AUTH_MISSING_OR_EXPIRED', 'Sign in to open the workspace.', {}, correlationId);
      }
      const applicationUser = authStore?.findApplicationUser(username);
      return jsonResponse(response, 200, {
        role,
        username,
        ...(applicationUser?.fullName ? { fullName: applicationUser.fullName } : {}),
        mfaEnabled: true,
      });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/auth/mfa/setup') {
      if (!allowApiRequest(request.socket.remoteAddress)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many authentication requests. Wait before trying again.', {}, correlationId);
      }
      if (!jwtSecret || !authStore || !mfaEncryptionKey) {
        return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'Secure account storage is required to set up two-factor authentication.', {}, correlationId);
      }
      const token = getCookie(request, 'bakunapass_mfa_setup');
      const preAuth = verifyAccessToken(token, jwtSecret);
      if (!preAuth || preAuth.scope !== 'mfa_setup') {
        return apiError(response, 401, 'MFA_SETUP_SESSION_REQUIRED', 'Sign in with your password before setting up two-factor authentication.', {}, correlationId);
      }
      const authenticationKey = `${request.socket.remoteAddress}:${preAuth.sub.toLowerCase()}`;
      if (!allowAuthenticationIpAttempt(request.socket.remoteAddress) || !allowAuthenticationAttempt(authenticationKey)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many authentication attempts. Wait 15 minutes before trying again.', {}, correlationId);
      }
      const existing = authStore.findMfaCredential(preAuth.sub);
      if (existing?.enabled) {
        return apiError(response, 409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled for this account.', {}, correlationId);
      }
      const secret = generateTotpSecret();
      const encrypted = encryptTotpSecret(secret, mfaEncryptionKey);
      authStore.savePendingMfa(preAuth.sub, encrypted);
      const label = encodeURIComponent(`BakunaPass:${preAuth.sub}`);
      const issuer = encodeURIComponent('BakunaPass');
      const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
      return jsonResponse(response, 200, { secret, otpauthUrl, issuer: 'BakunaPass', account: preAuth.sub });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/auth/mfa/verify') {
      if (!allowApiRequest(request.socket.remoteAddress)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many API requests. Please wait before trying again.', {}, correlationId);
      }
      if (!jwtSecret || !authStore || !mfaEncryptionKey) {
        return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'Secure account storage is required to verify two-factor authentication.', {}, correlationId);
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return apiError(response, error.statusCode || 400, 'MALFORMED_PAYLOAD', error.message, {}, correlationId);
      }
      const setupToken = verifyAccessToken(getCookie(request, 'bakunapass_mfa_setup'), jwtSecret);
      const challengeToken = verifyAccessToken(getCookie(request, 'bakunapass_mfa_challenge'), jwtSecret);
      const preAuth = setupToken?.scope === 'mfa_setup' ? setupToken
        : challengeToken?.scope === 'mfa_challenge' ? challengeToken : null;
      if (!preAuth) {
        return apiError(response, 401, 'MFA_SESSION_REQUIRED', 'Complete password sign-in before verifying your authenticator code.', {}, correlationId);
      }
      const authenticationKey = `${request.socket.remoteAddress}:${preAuth.sub.toLowerCase()}`;
      if (!allowAuthenticationIpAttempt(request.socket.remoteAddress) || !allowAuthenticationAttempt(authenticationKey)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many authentication attempts. Wait 15 minutes before trying again.', {}, correlationId);
      }
      const credential = authStore.findMfaCredential(preAuth.sub);
      if (!credential) {
        return apiError(response, 400, 'MFA_SETUP_REQUIRED', 'Start two-factor setup before verifying a code.', {}, correlationId);
      }
      const secret = decryptTotpSecret(credential, mfaEncryptionKey);
      const code = String(payload?.code || '').trim();
      if (preAuth.scope === 'mfa_setup') {
        if (credential.enabled) {
          return apiError(response, 409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled for this account.', {}, correlationId);
        }
        const acceptedStep = verifyTotpCode(secret, code);
        if (acceptedStep === null) {
          return apiError(response, 401, 'MFA_CODE_INVALID', 'That authenticator code is invalid or expired. Try the current six-digit code.', {}, correlationId);
        }
        const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('hex').toUpperCase());
        const challengeConsumed = authStore.consumeMfaChallenge({
          challengeId: preAuth.jti,
          username: preAuth.sub,
          scope: 'mfa_setup',
        });
        if (!challengeConsumed) {
          return apiError(response, 401, 'MFA_SESSION_EXPIRED', 'This two-factor setup session has expired or was already used. Sign in again.', {}, correlationId);
        }
        const enabled = authStore.enableMfa(preAuth.sub, {
          backupCodeHashes: recoveryCodes.map(hashBackupCode),
          acceptedStep,
        });
        if (!enabled) {
          return apiError(response, 409, 'MFA_ENROLLMENT_CHANGED', 'Two-factor setup changed. Sign in again and retry.', {}, correlationId);
        }
        const session = makeAccessToken(preAuth.sub, preAuth.role, jwtSecret);
        response.setHeader('Set-Cookie', [
          sessionCookie(session, 3600),
          mfaCookie('bakunapass_mfa_setup', '', 0),
          mfaCookie('bakunapass_mfa_challenge', '', 0),
        ]);
        return jsonResponse(response, 200, {
          role: preAuth.role,
          token: session,
          tokenType: 'Bearer',
          expiresIn: 3600,
          recoveryCodes,
        });
      }

      if (!credential.enabled) {
        return apiError(response, 409, 'MFA_SETUP_REQUIRED', 'Two-factor setup was not completed. Sign in again to enroll.', {}, correlationId);
      }
      const acceptedStep = verifyTotpCode(secret, code, Date.now(), credential.lastAcceptedStep);
      const codeValid = acceptedStep !== null || authStore.findMfaCredential(preAuth.sub)?.backupCodeHashes
        .includes(hashBackupCode(code));
      if (!codeValid) {
        return apiError(response, 401, 'MFA_CODE_INVALID', 'The authenticator or recovery code is invalid or has already been used.', {}, correlationId);
      }
      const challengeConsumed = authStore.consumeMfaChallenge({
        challengeId: preAuth.jti,
        username: preAuth.sub,
        scope: 'mfa_challenge',
      });
      if (!challengeConsumed) {
        return apiError(response, 401, 'MFA_SESSION_EXPIRED', 'This two-factor sign-in session has expired or was already used. Sign in again.', {}, correlationId);
      }
      const verified = acceptedStep !== null
        ? authStore.consumeMfaStep(preAuth.sub, acceptedStep)
        : authStore.consumeBackupCode(preAuth.sub, hashBackupCode(code));
      if (!verified) {
        return apiError(response, 401, 'MFA_CODE_INVALID', 'The authenticator or recovery code is invalid or has already been used.', {}, correlationId);
      }
      const session = makeAccessToken(preAuth.sub, preAuth.role, jwtSecret);
      response.setHeader('Set-Cookie', [
        sessionCookie(session, 3600),
        mfaCookie('bakunapass_mfa_setup', '', 0),
        mfaCookie('bakunapass_mfa_challenge', '', 0),
      ]);
      return jsonResponse(response, 200, {
        role: preAuth.role,
        token: session,
        tokenType: 'Bearer',
        expiresIn: 3600,
      });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/auth/register') {
      if (!allowApiRequest(request.socket.remoteAddress)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many API requests. Please wait before trying again.', {}, correlationId);
      }
      if (!jwtSecret || !hasBootstrapAdmin || !authStore) {
        return apiError(response, 503, 'AUTHENTICATION_NOT_CONFIGURED', 'Account registration is unavailable until the server has configured a trusted administrator account.', {}, correlationId);
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return apiError(response, error.statusCode || 400, 'MALFORMED_PAYLOAD', error.message, {}, correlationId);
      }
      const password = String(payload?.password || '');
      const fullName = String(payload?.fullName || '').trim();
      const email = String(payload?.email || '').trim().toLowerCase();
      const facility = String(payload?.facility || '').trim();
      const staffId = String(payload?.staffId || '').trim();
      const jobTitle = String(payload?.jobTitle || '').trim();
      if (fullName.length < 2 || fullName.length > 80) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Enter your full name using 2 to 80 characters.', { field: 'fullName' }, correlationId);
      }
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Enter a valid work email address.', { field: 'email' }, correlationId);
      }
      if (facility.length < 2 || facility.length > 80) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Enter your clinic or health facility using 2 to 80 characters.', { field: 'facility' }, correlationId);
      }
      if (!/^[A-Za-z0-9._/-]{2,40}$/.test(staffId)) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Enter a staff or employee ID using 2 to 40 letters, numbers, dots, underscores, hyphens, or slashes.', { field: 'staffId' }, correlationId);
      }
      if (!registrationJobTitles.has(jobTitle)) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Choose a supported staff job title from the registration list.', { field: 'jobTitle' }, correlationId);
      }
      if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 128) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Password must be between 12 and 128 bytes.', { field: 'password' }, correlationId);
      }
      if (authStore.findApplicationUserByEmail(email)) {
        return apiError(response, 409, 'ACCOUNT_ALREADY_EXISTS', 'An account request already uses that work email address.', { field: 'email' }, correlationId);
      }
      if (authStore.findApplicationUserByStaffId(staffId)) {
        return apiError(response, 409, 'ACCOUNT_ALREADY_EXISTS', 'An account request already uses that staff ID.', { field: 'staffId' }, correlationId);
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await scrypt(password, salt, 64);
      const username = `staff-${crypto.randomUUID()}`;
      try {
        if (authStore.findApplicationUserByEmail(email)) {
          return apiError(response, 409, 'ACCOUNT_ALREADY_EXISTS', 'An account request already uses that work email address.', { field: 'email' }, correlationId);
        }
        if (authStore.findApplicationUserByStaffId(staffId)) {
          return apiError(response, 409, 'ACCOUNT_ALREADY_EXISTS', 'An account request already uses that staff ID.', { field: 'staffId' }, correlationId);
        }
        authStore.createApplicationUser({
          username,
          salt,
          passwordHash: passwordHash.toString('hex'),
          role: 'facility_user',
          status: 'ACTIVE',
          fullName,
          email,
          facility,
          staffId,
          jobTitle,
        });
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return apiError(response, 409, 'ACCOUNT_ALREADY_EXISTS', 'An account request already exists with those staff details.', {}, correlationId);
        }
        throw error;
      }
      return jsonResponse(response, 201, {
        fullName,
        email,
        facility,
        staffId,
        jobTitle,
        role: 'facility_user',
        status: 'ACTIVE',
        message: 'Account created. Sign in with your work email and password; you will set up two-factor authentication on your first sign-in. An administrator can assign an operational role after verifying your staff details.',
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/v1/admin/accounts') {
      if (!authStore) {
        return apiError(response, 503, 'AUTHENTICATION_NOT_CONFIGURED', 'Account management is unavailable.', {}, correlationId);
      }
      if (getApiRole(request, jwtSecret, authStore, users) !== 'admin') {
        return apiError(response, 403, 'FORBIDDEN', 'Only an administrator can manage staff accounts.', {}, correlationId);
      }
      return jsonResponse(response, 200, authStore.listApplicationUsers());
    }

    const accountMatch = /^\/api\/v1\/admin\/accounts\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === 'PATCH' && accountMatch) {
      if (!authStore) {
        return apiError(response, 503, 'AUTHENTICATION_NOT_CONFIGURED', 'Account management is unavailable.', {}, correlationId);
      }
      if (getApiRole(request, jwtSecret, authStore, users) !== 'admin') {
        return apiError(response, 403, 'FORBIDDEN', 'Only an administrator can manage staff accounts.', {}, correlationId);
      }
      let username;
      try {
        username = decodeURIComponent(accountMatch[1]);
      } catch {
        return apiError(response, 400, 'INVALID_FORMAT', 'The account username path segment is malformed.', {}, correlationId);
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return apiError(response, error.statusCode || 400, 'MALFORMED_PAYLOAD', error.message, {}, correlationId);
      }
      const action = String(payload?.action || '').toUpperCase();
      const role = String(payload?.role || '');
      const accountRecord = authStore.findApplicationUser(username);
      if (accountRecord?.role === 'admin') {
        return apiError(response, 403, 'FORBIDDEN', 'Administrator accounts cannot be changed through staff role management.', {}, correlationId);
      }
      const assignableRoles = [
        'facility_user',
        'health_worker',
        'cold_chain_officer',
        'operations_manager',
      ];
      const pendingAction = accountRecord?.status === 'PENDING' && ['APPROVE', 'REJECT'].includes(action);
      const roleChange = accountRecord?.status === 'ACTIVE' && action === 'SET_ROLE' && assignableRoles.includes(role);
      const statusChange = (accountRecord?.status === 'ACTIVE' && action === 'SUSPEND')
        || (accountRecord?.status === 'SUSPENDED' && action === 'ACTIVATE');
      const validPendingAction = pendingAction
        && (action === 'REJECT' || assignableRoles.includes(role));
      if (!validPendingAction && !roleChange && !statusChange) {
        return apiError(response, 400, 'INVALID_FORMAT', 'Choose a valid review action and supported non-admin role.', {}, correlationId);
      }
      const account = authStore.updateApplicationUser(username, {
        status: action === 'REJECT' ? 'REJECTED'
          : action === 'SUSPEND' ? 'SUSPENDED'
            : 'ACTIVE',
        role: action === 'REJECT' || statusChange ? accountRecord.role : role,
      });
      if (!account) {
        return apiError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested account does not exist.', { username }, correlationId);
      }
      return jsonResponse(response, 200, account);
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/auth/logout') {
      response.setHeader('Set-Cookie', [
        sessionCookie('', 0),
        mfaCookie('bakunapass_mfa_setup', '', 0),
        mfaCookie('bakunapass_mfa_challenge', '', 0),
      ]);
      return jsonResponse(response, 200, { signedOut: true });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/v1/auth/token') {
      if (!allowApiRequest(request.socket.remoteAddress)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many API requests. Please wait before trying again.', {}, correlationId);
      }
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return apiError(response, error.statusCode || 400, 'MALFORMED_PAYLOAD', error.message, {}, correlationId);
      }
      if (!jwtSecret || !users.length) {
        return apiError(response, 503, 'AUTHENTICATION_NOT_CONFIGURED', 'Configure JWT_SECRET and API_USERS to enable role-based login.', {}, correlationId);
      }
      const username = String(payload?.username || payload?.email || '').trim();
      const authenticationKey = `${request.socket.remoteAddress}:${username.toLowerCase()}`;
      if (!allowAuthenticationIpAttempt(request.socket.remoteAddress) || !allowAuthenticationAttempt(authenticationKey)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many authentication attempts. Wait 15 minutes before trying again.', {}, correlationId);
      }
      const user = users.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
      const applicationAccount = user ? null
        : authStore?.findApplicationUser(username)
          || (() => {
            const matchingEmail = authStore?.findApplicationUserByEmail(username);
            return matchingEmail ? authStore.findApplicationUser(matchingEmail.username) : undefined;
          })();
      const applicationUser = applicationAccount;
      const passwordMatches = user
        ? typeof user.password === 'string' && constantTimeEqual(user.password, payload?.password || '')
        : Boolean(applicationUser && await scrypt(String(payload?.password || ''), applicationUser.salt, 64)
          .then((candidate) => crypto.timingSafeEqual(candidate, Buffer.from(applicationUser.passwordHash, 'hex'))));
      if ((!user && !applicationUser) || !passwordMatches) {
        return apiError(response, 401, 'UNAUTHORIZED', 'Work email or username and password are incorrect.', {}, correlationId);
      }
      const authenticatedUser = user || applicationUser;
      if (applicationUser?.status === 'PENDING') {
        return apiError(response, 403, 'ACCOUNT_PENDING', 'Your account request is awaiting administrator approval.', {}, correlationId);
      }
      if (applicationUser?.status !== undefined && applicationUser.status !== 'ACTIVE') {
        return apiError(response, 403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active. Contact your system administrator.', {}, correlationId);
      }
      if (!jwtSecret || !apiRoles.has(authenticatedUser.role)) {
        return apiError(response, 503, 'AUTHENTICATION_NOT_CONFIGURED', 'JWT_SECRET and a valid configured user role are required.', {}, correlationId);
      }
      if (!authStore || !mfaEncryptionKey) {
        return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'Secure account storage is required to complete two-factor authentication.', {}, correlationId);
      }
      const credential = authStore.findMfaCredential(authenticatedUser.username);
      const scope = credential?.enabled ? 'mfa_challenge' : 'mfa_setup';
      const challengeId = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      authStore.createMfaChallenge({
        challengeId,
        username: authenticatedUser.username,
        scope,
        expiresAt,
      });
      const preAuthToken = signAccessToken({
        sub: authenticatedUser.username,
        role: authenticatedUser.role,
        scope,
        jti: challengeId,
        exp: expiresAt,
      }, jwtSecret);
      const cookieName = scope === 'mfa_setup' ? 'bakunapass_mfa_setup' : 'bakunapass_mfa_challenge';
      response.setHeader('Set-Cookie', mfaCookie(cookieName, preAuthToken, 300));
      return jsonResponse(response, 202, {
        mfaRequired: true,
        enrollmentRequired: scope === 'mfa_setup',
        message: scope === 'mfa_setup'
          ? 'Set up an authenticator app to finish securing your account.'
          : 'Enter the code from your authenticator app to finish signing in.',
      });
    }

    const routeMatch = /^(?:\/api\/v1)?\/(requisitions|telemetry|stock|risk-assessment)(?:\/.*)?$/.exec(requestUrl.pathname);
    if (routeMatch) {
      if (!allowApiRequest(request.socket.remoteAddress)) {
        return apiError(response, 429, 'RATE_LIMITED', 'Too many API requests. Please wait before trying again.', {}, correlationId);
      }
      const serviceName = routeMatch[1] === 'requisitions' ? 'requisitions'
        : routeMatch[1] === 'telemetry' ? 'telemetry'
          : routeMatch[1] === 'stock' ? 'legacy' : 'mashup';
      let servicePath = requestUrl.pathname.replace(/^\/api\/v1/, '');
      if (/^\/(?:requisitions|telemetry|stock|risk-assessment)\/health$/.test(servicePath)) {
        servicePath = '/health';
      }
      const publicHealth = /\/health$/.test(servicePath);
      const role = getApiRole(request, jwtSecret, authStore, users);
      if (!publicHealth && (!role || !canAccessApi(role, requestUrl.pathname, request.method))) {
        const status = role ? 403 : 401;
        return apiError(response, status, role ? 'FORBIDDEN' : 'AUTH_MISSING_OR_EXPIRED', role
          ? 'Your role is not permitted to access this resource.'
          : 'A valid Bearer JWT is required when the gateway is exposed beyond the local machine.',
        {}, correlationId);
      }
      if (!jwtSecret && !isLoopback(request)) {
        return apiError(response, 503, 'AUTHENTICATION_NOT_CONFIGURED', 'Configure JWT_SECRET and API_USERS before exposing the API gateway.', {}, correlationId);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') {
        return apiError(response, 405, 'METHOD_NOT_ALLOWED', 'The requested method is not supported.', {}, correlationId);
      }
      let body;
      if (!['GET', 'HEAD'].includes(request.method)) {
        try {
          body = await readRawBody(request);
        } catch (error) {
          return apiError(response, error.statusCode || 400, 'MALFORMED_PAYLOAD', error.message, {}, correlationId);
        }
      }
      const targetUrl = new URL(`${servicePath}${requestUrl.search}`, serviceUrls[serviceName]);
      const username = getApiUsername(request, jwtSecret);
      try {
        const upstream = await fetch(targetUrl, {
          method: request.method,
          headers: {
            ...(request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {}),
            ...(request.headers.accept ? { Accept: request.headers.accept } : {}),
            'X-Correlation-ID': correlationId,
            ...(role ? { 'X-BakunaPass-Role': role } : {}),
            ...(username ? { 'X-BakunaPass-User': username } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(5000),
        });
        const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
        const upstreamBody = await upstream.arrayBuffer();
        response.writeHead(upstream.status, {
          'Content-Type': contentType,
          'X-Correlation-ID': correlationId,
          ...(upstream.headers.get('location') ? { Location: upstream.headers.get('location') } : {}),
        });
        return response.end(Buffer.from(upstreamBody));
      } catch {
        return apiError(response, 503, 'SERVICE_UNAVAILABLE', 'The target service is unreachable or timed out.', {
          targetService: serviceName,
        }, correlationId);
      }
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/notifications') {
      const notificationAuthorized = jwtSecret
        ? getApiRole(request, jwtSecret, authStore, users) === 'health_worker'
          && (!apiToken || isAuthorized(request, apiToken))
        : isAuthorized(request, apiToken);
      if (!notificationAuthorized) {
        return jsonResponse(response, 401, {
          error: apiToken
            ? 'A verified health-worker session and valid notification access token are required.'
            : 'A verified health-worker session is required to send notifications.',
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

    if (request.method === 'GET' && requestUrl.pathname === '/auth/') {
      response.writeHead(308, { Location: '/auth.html' });
      return response.end();
    }

    const workspacePath = ['/', '/index.html', '/workspace'].includes(requestUrl.pathname);
    if (workspacePath) {
      if (!getApiRole(request, jwtSecret, authStore, users)) {
        response.writeHead(302, { Location: '/auth.html' });
        return response.end();
      }
    }

    const publicFile = requestUrl.pathname === '/workspace'
      ? 'index.html'
      : publicFiles.get(requestUrl.pathname);
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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

export async function startBakunaPass({
  host = process.env.HOST || '127.0.0.1',
  serviceHost = process.env.SERVICE_HOST || '127.0.0.1',
  gatewayPort = Number(process.env.PORT || 3000),
  requisitionPort = Number(process.env.REQUISITION_SERVICE_PORT || 5001),
  telemetryPort = Number(process.env.TELEMETRY_SERVICE_PORT || 5002),
  legacyAdapterPort = Number(process.env.LEGACY_ADAPTER_PORT || 5003),
  legacySoapPort = Number(process.env.LEGACY_SOAP_PORT || 5004),
  mashupPort = Number(process.env.MASHUP_SERVICE_PORT || 5005),
  databasePath = process.env.DATABASE_PATH || path.join(projectDirectory, 'data', 'bakunapass.sqlite'),
  jwtSecret = process.env.JWT_SECRET,
  apiUsers = process.env.API_USERS,
  requisitionTelemetryUrl = process.env.REQUISITION_TELEMETRY_URL || '',
  weatherProvider = createOpenMeteoProvider(),
  allowedOrigin = process.env.CORS_ORIGIN || '',
  apiRateLimit,
  sendEmail = sendSmtpEmail,
  sendSms = sendTwilioSms,
} = {}) {
  if (!loopbackAddresses.has(host) && (!jwtSecret || !apiUsers)) {
    throw new TypeError('A non-loopback gateway requires JWT_SECRET and API_USERS.');
  }
  if (databasePath !== ':memory:') {
    await mkdir(path.dirname(databasePath), { recursive: true });
  }
  const store = createStore(databasePath);
  const telemetryServer = createServiceServer({ service: 'telemetry', store });
  let requisitionServer;
  let legacySoapServer;
  let legacyAdapterServer;
  let mashupServer;
  let gatewayServer;
  const openedServers = [];

  try {
    const actualTelemetryPort = await listen(telemetryServer, telemetryPort, serviceHost);
    openedServers.push(telemetryServer);
    requisitionServer = createServiceServer({
      service: 'requisitions',
      store,
      telemetryUrl: requisitionTelemetryUrl || `http://${serviceHost}:${actualTelemetryPort}`,
    });
    const actualRequisitionPort = await listen(requisitionServer, requisitionPort, serviceHost);
    openedServers.push(requisitionServer);
    legacySoapServer = createLegacySoapServer({ store });
    const actualLegacySoapPort = await listen(legacySoapServer, legacySoapPort, serviceHost);
    openedServers.push(legacySoapServer);
    legacyAdapterServer = createLegacyAdapterServer({
      soapUrl: `http://${serviceHost}:${actualLegacySoapPort}`,
    });
    const actualLegacyAdapterPort = await listen(legacyAdapterServer, legacyAdapterPort, serviceHost);
    openedServers.push(legacyAdapterServer);
    mashupServer = createMashupServer({
      telemetryUrl: `http://${serviceHost}:${actualTelemetryPort}`,
      legacyAdapterUrl: `http://${serviceHost}:${actualLegacyAdapterPort}`,
      getWeather: weatherProvider,
    });
    const actualMashupPort = await listen(mashupServer, mashupPort, serviceHost);
    openedServers.push(mashupServer);
    gatewayServer = createServer({
      serviceUrls: {
        telemetry: `http://${serviceHost}:${actualTelemetryPort}`,
        requisitions: `http://${serviceHost}:${actualRequisitionPort}`,
        legacy: `http://${serviceHost}:${actualLegacyAdapterPort}`,
        mashup: `http://${serviceHost}:${actualMashupPort}`,
      },
      jwtSecret,
      apiUsers,
      authStore: store,
      allowedOrigin,
      apiRateLimit,
      sendEmail,
      sendSms,
    });
    const actualGatewayPort = await listen(gatewayServer, gatewayPort, host);
    openedServers.push(gatewayServer);
    return {
      gatewayUrl: `http://${host}:${actualGatewayPort}`,
      serviceUrls: {
        requisitions: `http://${serviceHost}:${actualRequisitionPort}`,
        telemetry: `http://${serviceHost}:${actualTelemetryPort}`,
        legacyAdapter: `http://${serviceHost}:${actualLegacyAdapterPort}`,
        legacySoap: `http://${serviceHost}:${actualLegacySoapPort}`,
        mashup: `http://${serviceHost}:${actualMashupPort}`,
      },
      async close() {
        await Promise.all(openedServers.map((server) => new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })));
        store.close();
      },
    };
  } catch (error) {
    await Promise.all(openedServers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    store.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBakunaPass()
    .then((application) => {
      const { gatewayUrl, serviceUrls } = application;
      console.log(`BakunaPass API gateway is running at ${gatewayUrl}`);
      console.log(`Requisition service: ${serviceUrls.requisitions}`);
      console.log(`Telemetry service: ${serviceUrls.telemetry}`);
      console.log(`Legacy HIS adapter: ${serviceUrls.legacyAdapter}`);
      console.log(`Legacy SOAP HIS: ${serviceUrls.legacySoap}`);
      console.log(`Risk mashup service: ${serviceUrls.mashup}`);
      let shuttingDown = false;
      const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}; closing BakunaPass services.`);
        try {
          await application.close();
        } catch (error) {
          console.error('BakunaPass could not close cleanly:', error.message);
          process.exitCode = 1;
        }
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => {
      console.error('BakunaPass could not start:', error.message);
      process.exitCode = 1;
    });
}