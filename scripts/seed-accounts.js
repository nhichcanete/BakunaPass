#!/usr/bin/env node

import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'dotenv';

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultEnvPath = path.join(projectDirectory, '.env');
const seedAccounts = [
  { username: 'facility-demo', role: 'facility_user' },
  { username: 'health-worker-demo', role: 'health_worker' },
  { username: 'cold-chain-demo', role: 'cold_chain_officer' },
  { username: 'operations-manager-demo', role: 'operations_manager' },
  { username: 'system-admin-demo', role: 'admin' },
];
const retiredRoles = new Map([
  ['clinic_supervisor', 'operations_manager'],
  ['pho_admin', 'operations_manager'],
  ['warehouse_manager', 'operations_manager'],
  ['transit_logger', 'cold_chain_officer'],
]);

function updateEnvironmentFile(contents, name, value) {
  const lines = contents ? contents.split(/\r?\n/) : [];
  const keyPattern = new RegExp(`^\\s*${name}\\s*=`);
  const index = lines.findIndex((line) => keyPattern.test(line));
  if (index === -1) {
    lines.push(`${name}=${value}`);
  } else {
    lines[index] = `${name}=${value}`;
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export async function seedRoleAccounts({
  envPath = defaultEnvPath,
  environment = process.env,
  randomBytes = crypto.randomBytes,
} = {}) {
  const existingContents = await readFile(envPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const existing = parse(existingContents);
  if ((environment.JWT_SECRET && environment.JWT_SECRET !== existing.JWT_SECRET)
    || (environment.API_USERS && environment.API_USERS !== existing.API_USERS)) {
    throw new Error('Unset externally provided JWT_SECRET/API_USERS values before seeding so the generated local credentials are the active configuration.');
  }
  const nodeEnvironment = environment.NODE_ENV || existing.NODE_ENV || '';
  const host = environment.HOST || existing.HOST || '127.0.0.1';
  if (nodeEnvironment.toLowerCase() === 'production'
    || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Demo accounts can only be seeded for a local, non-production BakunaPass instance.');
  }

  let jwtSecret = existing.JWT_SECRET || '';
  if (jwtSecret && Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('The existing JWT_SECRET must contain at least 32 bytes; it was not changed.');
  }
  if (!jwtSecret) {
    jwtSecret = randomBytes(32).toString('base64url');
  }

  let apiUsers = [];
  if (existing.API_USERS?.trim()) {
    try {
      apiUsers = JSON.parse(existing.API_USERS);
    } catch {
      throw new Error('The existing API_USERS value is not valid JSON; it was not changed.');
    }
    if (!Array.isArray(apiUsers)) {
      throw new Error('The existing API_USERS value must be a JSON array; it was not changed.');
    }
    const usernames = new Set();
    for (const user of apiUsers) {
      const role = retiredRoles.get(user?.role) || user?.role;
      if (!user || typeof user.username !== 'string' || !user.username.trim()
        || typeof user.password !== 'string' || user.password.length < 12
        || !['facility_user', 'health_worker', 'cold_chain_officer', 'operations_manager', 'admin'].includes(role)
        || usernames.has(user.username.toLowerCase())) {
        throw new Error('The existing API_USERS entries must have unique usernames, passwords of at least 12 characters, and supported roles; they were not changed.');
      }
      usernames.add(user.username.toLowerCase());
    }
    const collisions = seedAccounts.filter(({ username }) => usernames.has(username.toLowerCase()));
    if (collisions.length) {
      throw new Error(`Rename these existing account usernames before seeding: ${collisions.map(({ username }) => username).join(', ')}.`);
    }
  }

  const generatedAccounts = seedAccounts.map(({ username, role }) => ({
    username,
    password: randomBytes(24).toString('base64url'),
    role,
  }));
  apiUsers.push(...generatedAccounts);
  const nextContents = updateEnvironmentFile(
    updateEnvironmentFile(existingContents, 'JWT_SECRET', jwtSecret),
    'API_USERS',
    JSON.stringify(apiUsers),
  );
  await writeFile(envPath, nextContents, { encoding: 'utf8', mode: 0o600 });
  return generatedAccounts;
}

async function main() {
  const accounts = await seedRoleAccounts();
  console.log('Local role accounts created in .env. Copy these credentials to a private location:');
  console.table(accounts.map(({ username, password, role }) => ({ username, password, role })));
  console.log('Restart BakunaPass, then sign in and enroll an authenticator app for each account.');
  console.log('Do not commit or share the .env file or these passwords.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
