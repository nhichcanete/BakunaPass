import crypto from 'node:crypto';

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stepSeconds = 30;

export function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let encoded = '';
  for (let offset = 0; offset < bits.length; offset += 5) {
    encoded += base32Alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, '0'), 2)];
  }
  return encoded;
}

function decodeBase32(value) {
  const normalized = String(value).replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) {
      throw new TypeError('The authenticator secret is malformed.');
    }
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function createTotpCode(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / (stepSeconds * 1000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(secret, code, timestamp = Date.now(), lastAcceptedStep = -1) {
  if (!/^\d{6}$/.test(String(code))) {
    return null;
  }
  const currentStep = Math.floor(timestamp / (stepSeconds * 1000));
  const provided = Buffer.from(String(code));
  for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
    if (step <= lastAcceptedStep || step < 0) {
      continue;
    }
    const expected = Buffer.from(createTotpCode(secret, step * stepSeconds * 1000));
    if (crypto.timingSafeEqual(provided, expected)) {
      return step;
    }
  }
  return null;
}

export function encryptTotpSecret(secret, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    encryptedSecret: encrypted.toString('base64'),
    secretIv: iv.toString('base64'),
    secretTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptTotpSecret(credential, encryptionKey) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(credential.secretIv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(credential.secretTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(credential.encryptedSecret, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
