import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationHtml, createServer } from './server.js';

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('health endpoint confirms the backend is running', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

test('static server does not expose environment files', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/.env.example`);
    assert.equal(response.status, 404);
  });
});

test('notification email HTML styles the message and escapes user content', () => {
  const html = createNotificationHtml({
    subject: 'Booster <update>',
    message: 'Hello, <script>alert("x")</script>\nPlease contact your clinic.',
  });

  assert.match(html, /BakunaPass/);
  assert.match(html, /Booster &lt;update&gt;/);
  assert.match(html, /Hello, &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>Please contact your clinic\./);
  assert.doesNotMatch(html, /<script>/);
});

test('notification email emphasizes the patient name and vaccination status', () => {
  const html = createNotificationHtml({
    subject: 'Vaccination update',
    message: 'Dear Raven Santos, your vaccination status is currently Booster complete.',
  });

  assert.match(html, /Dear <strong>Raven Santos<\/strong>/);
  assert.match(html, /background-color:#fff1d6[^>]*>Booster complete<\/strong>/);
});

test('notification endpoint sends valid email through the configured provider', async () => {
  let sentNotification;

  await withServer({
    sendEmail: async (notification) => {
      sentNotification = notification;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'email',
        to: 'patient@example.com',
        subject: 'Follow-up',
        message: 'Please contact your clinic.',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: true, channel: 'email' });
  });

  assert.equal(sentNotification.target, 'patient@example.com');
  assert.equal(sentNotification.subject, 'Follow-up');
  assert.equal(sentNotification.message, 'Please contact your clinic.');
});

test('notification endpoint rejects invalid recipient data', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', to: 'bad-address', message: 'Hello' }),
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /valid email/i);
  });
});
const validEmail = JSON.stringify({ channel: 'email', to: 'patient@example.com', message: 'Hello' });
const post = (baseUrl, body, headers = {}) => fetch(`${baseUrl}/api/notifications`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body,
});

test('notification endpoint requires the access token when one is configured', async () => {
  let sent = 0;
  await withServer({ apiToken: 'secret', sendEmail: async () => { sent += 1; } }, async (baseUrl) => {
    assert.equal((await post(baseUrl, validEmail)).status, 401);
    assert.equal((await post(baseUrl, validEmail, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(baseUrl, validEmail, { Authorization: 'Bearer secret' })).status, 200);
  });
  assert.equal(sent, 1);
});

test('notification endpoint is rate limited', async () => {
  await withServer({ rateLimit: { limit: 2, windowMs: 60_000 }, sendEmail: async () => {} }, async (baseUrl) => {
    assert.equal((await post(baseUrl, validEmail)).status, 200);
    assert.equal((await post(baseUrl, validEmail)).status, 200);
    assert.equal((await post(baseUrl, validEmail)).status, 429);
  });
});

test('notification endpoint sends SMS through the configured provider', async () => {
  let sentNotification;
  await withServer({ sendSms: async (notification) => { sentNotification = notification; } }, async (baseUrl) => {
    const response = await post(baseUrl, JSON.stringify({ channel: 'sms', to: '+639171234567', message: 'Hello' }));
    assert.equal(response.status, 200);
  });
  assert.equal(sentNotification.target, '+639171234567');
});

test('static files are served with security headers', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});
