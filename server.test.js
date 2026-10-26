import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationHtml, createServer } from './server.js';
import { createTotpCode } from './mfa.js';
import { createStore } from './store.js';

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
    options.authStore?.close();
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

test('login and registration page assets are served separately from the dashboard', async () => {
  await withServer({}, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/auth`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const markup = await page.text();
    assert.match(markup, /id="login-form"/);
    assert.match(markup, /id="register-form"/);
    assert.match(markup, /Create account/);
    assert.doesNotMatch(markup, /local-demo-button|Continue with local demo/);
    assert.match(markup, /auth-brand-seal/);

    const staticPage = await fetch(`${baseUrl}/auth.html`);
    assert.equal(staticPage.status, 200);
    const loginAlias = await fetch(`${baseUrl}/login`);
    assert.equal(loginAlias.status, 200);
    const trailingSlash = await fetch(`${baseUrl}/auth/`);
    assert.equal(trailingSlash.status, 200);
    assert.equal(new URL(trailingSlash.url).pathname, '/auth.html');

    const script = await fetch(`${baseUrl}/auth.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
  });
});

test('public routes open sign-in first and protect the workspace behind an authenticated session', async () => {
  const apiUsers = [{ username: 'portal-admin', password: 'portal-admin-password', role: 'admin' }];
  const authStore = createStore(':memory:');
  await withServer({ jwtSecret: 'a-test-signing-secret-that-is-long-enough', apiUsers, authStore }, async (baseUrl) => {
    for (const route of ['/', '/index.html', '/workspace']) {
      const page = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
      assert.equal(page.status, 302);
      assert.equal(page.headers.get('location'), '/auth.html');
    }
    const login = await fetch(`${baseUrl}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'portal-admin', password: 'portal-admin-password' }),
    });
    assert.equal(login.status, 202);
    const setupCookie = login.headers.get('set-cookie').split(';')[0];
    const setup = await fetch(`${baseUrl}/api/v1/auth/mfa/setup`, {
      method: 'POST',
      headers: { Cookie: setupCookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const { secret } = await setup.json();
    const verification = await fetch(`${baseUrl}/api/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: { Cookie: setupCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: createTotpCode(secret) }),
    });
    assert.equal(verification.status, 200);
    assert.match(verification.headers.get('set-cookie'), /HttpOnly/);
    assert.match(verification.headers.get('set-cookie'), /SameSite=Strict/);
    const cookie = verification.headers.get('set-cookie').split(';')[0];
    const session = await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Cookie: cookie } });
    assert.deepEqual(await session.json(), {
      role: 'admin',
      username: 'portal-admin',
      mfaEnabled: true,
    });
    const workspace = await fetch(`${baseUrl}/workspace`, { headers: { Cookie: cookie } });
    assert.equal(workspace.status, 200);
    assert.match(workspace.headers.get('content-type'), /text\/html/);
    assert.match(await workspace.text(), /BakunaPass operations portal/);
    const signedOut = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(signedOut.status, 200);
    assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/);
    const afterLogout = await fetch(`${baseUrl}/workspace`, {
      headers: { Cookie: signedOut.headers.get('set-cookie').split(';')[0] },
      redirect: 'manual',
    });
    assert.equal(afterLogout.status, 302);
  });
});

test('operations portal module is served as a browser module', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/integration-ui.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /Assign a registered batch/);
  });
});
