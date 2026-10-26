import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTotpCode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  verifyTotpCode,
} from './mfa.js';

test('TOTP matches the RFC 6238 SHA-1 vector and rejects a reused time step', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const code = createTotpCode(secret, 59_000);
  assert.equal(code, '287082');
  assert.equal(verifyTotpCode(secret, code, 59_000), 1);
  assert.equal(verifyTotpCode(secret, code, 59_000, 1), null);
});

test('authenticator secrets are encrypted and generated secrets decode to six-digit codes', () => {
  const encryptionKey = Buffer.alloc(32, 7);
  const secret = generateTotpSecret();
  const credential = encryptTotpSecret(secret, encryptionKey);
  assert.equal(credential.encryptedSecret.includes(secret), false);
  assert.equal(decryptTotpSecret(credential, encryptionKey), secret);
  assert.match(createTotpCode(secret), /^\d{6}$/);
});
