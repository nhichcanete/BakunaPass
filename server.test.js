import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.js';

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