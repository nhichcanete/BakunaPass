import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startBakunaPass } from './server.js';
import { createTotpCode } from './mfa.js';
import { createOpenMeteoProvider } from './services/mashup.js';
import { runLoadProfile, runLoadTest } from './scripts/loadtest.js';
import { seedRoleAccounts } from './scripts/seed-accounts.js';
import { createStore } from './store.js';
import { parse as parseDotenv } from 'dotenv';

async function withApplication(options, run) {
  const application = await startBakunaPass({
    host: '127.0.0.1',
    gatewayPort: 0,
    requisitionPort: 0,
    telemetryPort: 0,
    legacyAdapterPort: 0,
    legacySoapPort: 0,
    mashupPort: 0,
    databasePath: ':memory:',
    ...options,
  });
  try {
    await run(application.gatewayUrl, application);
  } finally {
    await application.close();
  }
}

test('all backend service roots expose health responses for the service tabs', async () => {
  await withApplication({}, async (baseUrl, application) => {
    assert.deepEqual(
      Object.keys(application.serviceUrls).sort(),
      ['legacyAdapter', 'legacySoap', 'mashup', 'requisitions', 'telemetry'],
    );
    const expected = [
      ['requisitions', 'requisitions'],
      ['telemetry', 'telemetry'],
      ['legacyAdapter', 'legacy-his-rest-soap-adapter'],
      ['legacySoap', 'simulated-legacy-soap-his'],
      ['mashup', 'vaccine-risk-mashup-engine'],
    ];
    for (const [serviceUrlName, serviceName] of expected) {
      const response = await fetch(`${application.serviceUrls[serviceUrlName]}/`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'UP', service: serviceName });
    }
    const ready = await fetch(`${baseUrl}/api/ready`);
    assert.equal(ready.status, 200);
    assert.ok((await ready.json()).services.every(({ status }) => status === 'UP'));
  });
});

function jsonPost(url, payload, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const enrolledMfaSecrets = new Map();
const enrolledRecoveryCodes = new Map();

async function completeMfaLogin(baseUrl, username, password) {
  const passwordStep = await jsonPost(`${baseUrl}/api/v1/auth/token`, { username, password });
  assert.equal(passwordStep.status, 202);
  const preAuthCookie = passwordStep.headers.get('set-cookie').split(';')[0];
  const passwordResult = await passwordStep.json();
  let secret = enrolledMfaSecrets.get(username);
  if (passwordResult.enrollmentRequired) {
    const setupResponse = await jsonPost(`${baseUrl}/api/v1/auth/mfa/setup`, {}, { Cookie: preAuthCookie });
    assert.equal(setupResponse.status, 200);
    ({ secret } = await setupResponse.json());
    enrolledMfaSecrets.set(username, secret);
  } else {
    assert.equal(passwordResult.mfaRequired, true);
  }
  const recoveryCodes = enrolledRecoveryCodes.get(username) || [];
  const code = !passwordResult.enrollmentRequired && recoveryCodes.length
    ? recoveryCodes.pop()
    : createTotpCode(secret);
  const verifyResponse = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
    code,
  }, { Cookie: preAuthCookie });
  assert.equal(verifyResponse.status, 200);
  const credentials = await verifyResponse.json();
  if (credentials.recoveryCodes) {
    enrolledRecoveryCodes.set(username, credentials.recoveryCodes);
  }
  return {
    response: verifyResponse,
    credentials,
    token: credentials.token,
    recoveryCodes: credentials.recoveryCodes,
  };
}

const testAccountsByRole = {
  facility_user: { username: 'facility-user', password: 'facility-user-password' },
  health_worker: { username: 'health-worker', password: 'health-worker-password' },
  cold_chain_officer: { username: 'cold-chain', password: 'cold-chain-password' },
  operations_manager: { username: 'operations-manager', password: 'operations-manager-password' },
  admin: { username: 'system-admin', password: 'system-admin-password' },
};

async function withAuthenticatedApplication(roles, options, run) {
  const apiUsers = roles.map((role) => ({
    ...testAccountsByRole[role],
    role,
  }));
  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers,
    ...options,
  }, async (baseUrl, application) => {
    const tokens = {};
    for (const role of roles) {
      const { token } = await completeMfaLogin(
        baseUrl,
        testAccountsByRole[role].username,
        testAccountsByRole[role].password,
      );
      tokens[role] = token;
    }
    await run(baseUrl, application, tokens);
  });
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

const telemetry = {
  vaccineId: 'VAX-TEST-01',
  vaccineName: 'Measles',
  currentTempCelsius: 4.5,
  safeRangeCelsius: { min: 2, max: 8 },
  humidityPercent: 60,
  shipmentId: 'SHIP-TEST-01',
};

test('gateway routes service health checks and returns a correlation id', async () => {
  await withApplication({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/telemetry/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'UP', service: 'telemetry' });
    assert.ok(response.headers.get('x-correlation-id'));
  });
});

test('REST-to-SOAP inventory adapter reads stock and reserves it through the SOAP service', async () => {
  await withAuthenticatedApplication(['operations_manager'], {}, async (baseUrl, application, tokens) => {
    const wsdlResponse = await fetch(`${application.serviceUrls.legacySoap}/wsdl`);
    assert.equal(wsdlResponse.status, 200);
    assert.match(await wsdlResponse.text(), /LegacyInventorySoapBinding/);
    const gatewayWsdl = await fetch(`${baseUrl}/api/v1/stock/wsdl`, {
      headers: authHeaders(tokens.operations_manager),
    });
    assert.equal(gatewayWsdl.status, 200);
    assert.match(await gatewayWsdl.text(), /LegacyInventorySoapBinding/);

    const inventory = await fetch(`${baseUrl}/api/v1/stock/sync/VAX-1001`, {
      headers: authHeaders(tokens.operations_manager),
    });
    assert.equal(inventory.status, 200);
    assert.match(inventory.headers.get('content-type'), /application\/json/);
    assert.equal((await inventory.json()).stockQuantity, 500);

    const warehouse = await fetch(`${baseUrl}/api/v1/stock/warehouse/WAREHOUSE-MNL`, {
      headers: authHeaders(tokens.operations_manager),
    });
    assert.equal(warehouse.status, 200);
    assert.equal((await warehouse.json()).items.length, 3);

    const soap = await fetch(`${application.serviceUrls.legacySoap}/soap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        SOAPAction: 'urn:BakunaPassLegacyInventory/GetInventoryBatch',
      },
      body: '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><inv:GetInventoryBatch xmlns:inv="urn:BakunaPassLegacyInventory"><inv:VaccineId>VAX-1001</inv:VaccineId></inv:GetInventoryBatch></soap:Body></soap:Envelope>',
    });
    assert.equal(soap.status, 200);
    assert.match(await soap.text(), /<StockQuantity>500<\/StockQuantity>/);

    const reservation = await jsonPost(`${baseUrl}/api/v1/stock/reserve`, {
      vaccineId: 'VAX-1001',
      quantity: 20,
    }, authHeaders(tokens.operations_manager));
    assert.equal(reservation.status, 200);
    assert.equal((await reservation.json()).stockQuantity, 480);

    const insufficient = await jsonPost(`${baseUrl}/api/v1/stock/reserve`, {
      vaccineId: 'VAX-1001',
      quantity: 1000,
    }, authHeaders(tokens.operations_manager));
    assert.equal(insufficient.status, 409);
    assert.equal((await insufficient.json()).error, 'INSUFFICIENT_STOCK');
  });
});

test('risk mashup combines telemetry, legacy inventory, and Open-Meteo data with explainable output', async () => {
  let weatherRequest;
  await withAuthenticatedApplication(['cold_chain_officer'], {
    weatherProvider: async (coordinates) => {
      weatherRequest = coordinates;
      return {
        status: 'AVAILABLE',
        source: 'Open-Meteo',
        cached: false,
        temperatureCelsius: 38,
        humidityPercent: 62,
        observedAt: new Date().toISOString(),
      };
    },
  }, async (baseUrl, application, tokens) => {
    const response = await fetch(`${baseUrl}/api/v1/risk-assessment/shipment/SHIP-1001`, {
      headers: authHeaders(tokens.cold_chain_officer),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.assessment.level, 'ELEVATED');
    assert.equal(result.assessment.score, 50);
    assert.equal(result.sources.telemetry.status, 'AVAILABLE');
    assert.equal(result.sources.legacyInventory.status, 'AVAILABLE');
    assert.equal(result.sources.legacyInventory.stockQuantity, 500);
    assert.equal(result.sources.weather.temperatureCelsius, 38);
    assert.deepEqual(weatherRequest, { latitude: 14.5995, longitude: 120.9842 });
    assert.match(result.assessment.reasons.join(' '), /Open-Meteo/);
  });
});

test('risk mashup labels weather outages and stale telemetry as insufficient instead of safe', async () => {
  await withAuthenticatedApplication(['cold_chain_officer'], {
    weatherProvider: async () => ({
      status: 'UNAVAILABLE',
      source: 'Open-Meteo',
      error: 'External provider timeout',
    }),
  }, async (baseUrl, application, tokens) => {
    const response = await fetch(`${baseUrl}/risk-assessment/shipment/SHIP-1001`, {
      headers: authHeaders(tokens.cold_chain_officer),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.assessment.level, 'INSUFFICIENT_DATA');
    assert.equal(result.assessment.score, null);
    assert.equal(result.sources.weather.status, 'UNAVAILABLE');
    assert.ok(result.assessment.reasons.some((reason) => /weather data is unavailable/.test(reason)));
  });
});

test('telemetry returns the same batch as JSON or XML based on Accept', async () => {
  await withAuthenticatedApplication(['cold_chain_officer'], {}, async (baseUrl, application, tokens) => {
    const json = await fetch(`${baseUrl}/api/v1/telemetry/VAX-1001`, {
      headers: { ...authHeaders(tokens.cold_chain_officer), Accept: 'application/json' },
    });
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /application\/json/);
    assert.equal((await json.json()).coldChainStatus, 'OK');

    const xml = await fetch(`${baseUrl}/telemetry/VAX-1001`, {
      headers: { ...authHeaders(tokens.cold_chain_officer), Accept: 'application/xml' },
    });
    assert.equal(xml.status, 200);
    assert.match(xml.headers.get('content-type'), /application\/xml/);
    assert.match(await xml.text(), /<safeRangeCelsius min="2" max="8" \/>/);
  });
});

test('telemetry accepts JSON and XML, stores history, and derives breach status', async () => {
  await withAuthenticatedApplication(['admin'], {}, async (baseUrl, application, tokens) => {
    const telemetryServiceUrl = application.serviceUrls.telemetry;
    const jsonResponse = await jsonPost(`${telemetryServiceUrl}/telemetry`, telemetry);
    assert.equal(jsonResponse.status, 201);
    assert.deepEqual((await jsonResponse.json()).safeRangeCelsius, { min: 2, max: 8 });

    const breach = await jsonPost(`${telemetryServiceUrl}/telemetry`, {
      ...telemetry,
      currentTempCelsius: 9,
    });
    assert.equal((await breach.json()).coldChainStatus, 'BREACH');
    const safeAgain = await jsonPost(`${telemetryServiceUrl}/telemetry`, {
      vaccineId: telemetry.vaccineId,
      currentTempCelsius: 4,
    });
    assert.equal((await safeAgain.json()).coldChainStatus, 'BREACH');

    const changedPolicy = await jsonPost(`${telemetryServiceUrl}/telemetry`, {
      ...telemetry,
      safeRangeCelsius: { min: -10, max: 50 },
    });
    assert.equal(changedPolicy.status, 409);
    assert.equal((await changedPolicy.json()).error, 'SAFE_RANGE_IMMUTABLE');

    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
      <vaccineBatch><vaccineId>VAX-TEST-02</vaccineId><vaccineName>BCG &amp; booster</vaccineName>
      <currentTempCelsius>9</currentTempCelsius><safeRangeCelsius min="2" max="8" />
      <humidityPercent>65</humidityPercent></vaccineBatch>`;
    const xmlResponse = await fetch(`${telemetryServiceUrl}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: xmlBody,
    });
    assert.equal(xmlResponse.status, 201);
    assert.match(xmlResponse.headers.get('content-type'), /application\/xml/);
    assert.match(await xmlResponse.text(), /<coldChainStatus>BREACH<\/coldChainStatus>/);

    const history = await fetch(`${telemetryServiceUrl}/telemetry/VAX-TEST-01/history`);
    assert.equal(history.status, 200);
    const readings = await history.json();
    assert.equal(readings.length, 3);
    assert.equal(readings[0].coldChainStatus, 'OK');
    assert.equal(readings[1].coldChainStatus, 'BREACH');
  });
});

test('telemetry returns structured errors for malformed and unsupported payloads', async () => {
  await withAuthenticatedApplication(['admin'], {}, async (baseUrl, application, tokens) => {
    const telemetryServiceUrl = application.serviceUrls.telemetry;
    const missing = await jsonPost(`${telemetryServiceUrl}/telemetry`, { vaccineId: 'VAX-01' });
    assert.equal(missing.status, 400);
    const missingError = await missing.json();
    assert.equal(missingError.error, 'MISSING_REQUIRED_FIELD');
    assert.equal(missingError.correlationId, missing.headers.get('x-correlation-id'));
    assert.ok(Number.isFinite(Date.parse(missingError.timestamp)));

    const malformedJson = await jsonPost(`${telemetryServiceUrl}/telemetry`, '{"broken": }');
    assert.equal(malformedJson.status, 400);
    assert.equal((await malformedJson.json()).error, 'MALFORMED_PAYLOAD');

    const malformedXml = await fetch(`${telemetryServiceUrl}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: '<vaccineBatch><vaccineId>VAX-01</vaccineBatch>',
    });
    assert.equal(malformedXml.status, 400);
    assert.equal((await malformedXml.json()).error, 'MALFORMED_PAYLOAD');

    const unsupported = await fetch(`${telemetryServiceUrl}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not a supported representation',
    });
    assert.equal(unsupported.status, 415);
    assert.equal((await unsupported.json()).error, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

test('requisition service verifies assigned vaccine batches over HTTP using JSON and XML', async () => {
  await withAuthenticatedApplication(['facility_user'], {}, async (baseUrl, application, tokens) => {
    for (const telemetryFormat of ['json', 'xml']) {
      const response = await jsonPost(`${baseUrl}/api/v1/requisitions`, {
        clinicId: 'RHU-0101',
        vaccineType: 'Pentavalent (DPT-HepB-Hib)',
        quantity: 50,
        vaccineId: 'VAX-1001',
        telemetryFormat,
      }, authHeaders(tokens.facility_user));
      assert.equal(response.status, 201);
      const requisition = await response.json();
      assert.equal(requisition.status, 'APPROVED');
      assert.equal(requisition.telemetryStatus, 'OK');
    }
  });
});

test('requisition service rejects cold-chain breaches and unknown batches', async () => {
  await withAuthenticatedApplication(['facility_user'], {}, async (baseUrl, application, tokens) => {
    const headers = authHeaders(tokens.facility_user);
    const breach = await jsonPost(`${baseUrl}/requisitions`, {
      clinicId: 'CLN-014',
      vaccineType: 'Measles',
      quantity: 12,
      vaccineId: 'VAX-1002',
    }, headers);
    assert.equal(breach.status, 409);
    const rejected = await breach.json();
    assert.equal(rejected.error, 'COLD_CHAIN_BREACH');
    assert.equal(rejected.details.requisition.status, 'REJECTED');

    const unknown = await jsonPost(`${baseUrl}/requisitions`, {
      clinicId: 'CLN-014',
      vaccineType: 'Measles',
      quantity: 12,
      vaccineId: 'VAX-9999',
    }, headers);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'RESOURCE_NOT_FOUND');

    const requisitions = await fetch(`${baseUrl}/requisitions`, { headers });
    assert.equal((await requisitions.json()).length, 1);
  });
});

test('requisition endpoints validate fields and return not found for unknown identifiers', async () => {
  await withAuthenticatedApplication(['facility_user'], {}, async (baseUrl, application, tokens) => {
    const headers = authHeaders(tokens.facility_user);
    const invalid = await jsonPost(`${baseUrl}/requisitions`, {
      clinicId: 'bad',
      vaccineType: 'Measles',
      quantity: 0,
    }, headers);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'INVALID_FORMAT');

    const missing = await fetch(`${baseUrl}/requisitions/REQ-DOES-NOT-EXIST`, { headers });
    assert.equal(missing.status, 404);
  });
});

test('approval cannot bypass batch verification and fails closed when telemetry is unreachable', async () => {
  await withAuthenticatedApplication(['facility_user', 'operations_manager'], {}, async (baseUrl, application, tokens) => {
    const facilityHeaders = authHeaders(tokens.facility_user);
    const reviewerHeaders = authHeaders(tokens.operations_manager);
    const pendingResponse = await jsonPost(`${baseUrl}/requisitions`, {
      clinicId: 'RHU-0101',
      vaccineType: 'Measles',
      quantity: 20,
    }, facilityHeaders);
    const pending = await pendingResponse.json();
    assert.equal(pending.status, 'PENDING');

    const approval = await fetch(`${baseUrl}/requisitions/${pending.id}/status`, {
      method: 'PUT',
      headers: { ...reviewerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED' }),
    });
    assert.equal(approval.status, 409);
    assert.equal((await approval.json()).error, 'BATCH_REQUIRED');
  });

  await withAuthenticatedApplication(['facility_user'], {
    requisitionTelemetryUrl: 'http://127.0.0.1:1',
  }, async (baseUrl, application, tokens) => {
    const failed = await jsonPost(`${baseUrl}/requisitions`, {
      clinicId: 'RHU-0101',
      vaccineType: 'Measles',
      quantity: 20,
      vaccineId: 'VAX-1001',
    }, authHeaders(tokens.facility_user));
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'SERVICE_UNAVAILABLE');
    const list = await fetch(`${baseUrl}/requisitions`, {
      headers: authHeaders(tokens.facility_user),
    });
    assert.deepEqual(await list.json(), []);
  });
});

test('reviewers can assign and verify a matching batch before approving a pending requisition', async () => {
  await withAuthenticatedApplication(['facility_user', 'operations_manager'], {}, async (baseUrl, application, tokens) => {
    const facilityHeaders = authHeaders(tokens.facility_user);
    const reviewerHeaders = authHeaders(tokens.operations_manager);
    const created = await fetch(`${baseUrl}/api/v1/requisitions`, {
      method: 'POST',
      headers: { ...facilityHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clinicId: 'RHU-0101', vaccineType: 'BCG', quantity: 20 }),
    });
    assert.equal(created.status, 201);
    const pending = await created.json();
    assert.equal(pending.status, 'PENDING');

    const mismatched = await fetch(`${baseUrl}/api/v1/requisitions/${pending.id}/status`, {
      method: 'PUT',
      headers: { ...reviewerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED', vaccineId: 'VAX-1001' }),
    });
    assert.equal(mismatched.status, 409);
    assert.equal((await mismatched.json()).error, 'BATCH_VACCINE_MISMATCH');
    const stillPending = await fetch(`${baseUrl}/api/v1/requisitions/${pending.id}`, {
      headers: reviewerHeaders,
    });
    assert.equal((await stillPending.json()).vaccineId, null);

    const approved = await fetch(`${baseUrl}/api/v1/requisitions/${pending.id}/status`, {
      method: 'PUT',
      headers: { ...reviewerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED', vaccineId: 'VAX-1003' }),
    });
    assert.equal(approved.status, 200);
    const result = await approved.json();
    assert.equal(result.status, 'APPROVED');
    assert.equal(result.vaccineId, 'VAX-1003');
  });
});

test('telemetry and requisition records survive a service restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bakunapass-test-'));
  const databasePath = path.join(directory, 'records.sqlite');
  const start = () => startBakunaPass({
    host: '127.0.0.1',
    gatewayPort: 0,
    requisitionPort: 0,
    telemetryPort: 0,
    legacyAdapterPort: 0,
    legacySoapPort: 0,
    mashupPort: 0,
    databasePath,
  });
  let application;
  try {
    application = await start();
    const stored = await jsonPost(`${application.serviceUrls.telemetry}/telemetry`, telemetry);
    assert.equal(stored.status, 201);
    const created = await jsonPost(`${application.serviceUrls.requisitions}/requisitions`, {
      clinicId: 'RHU-0101',
      vaccineType: 'Measles',
      quantity: 12,
    });
    assert.equal(created.status, 201);
    await application.close();
    application = null;
    application = await start();
    const batch = await fetch(`${application.serviceUrls.telemetry}/telemetry/VAX-TEST-01`);
    assert.equal((await batch.json()).currentTempCelsius, 4.5);
    const requisitions = await fetch(`${application.serviceUrls.requisitions}/requisitions`);
    assert.equal((await requisitions.json()).length, 1);
  } finally {
    if (application) {
      await application.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('database migration consolidates retired operational roles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bakunapass-role-migration-'));
  const databasePath = path.join(directory, 'roles.sqlite');
  let store;
  try {
    store = createStore(databasePath);
    for (const [username, role, expectedRole] of [
      ['old-supervisor', 'clinic_supervisor', 'operations_manager'],
      ['old-pho-admin', 'pho_admin', 'operations_manager'],
      ['old-warehouse', 'warehouse_manager', 'operations_manager'],
      ['old-transit-logger', 'transit_logger', 'cold_chain_officer'],
    ]) {
      store.createApplicationUser({
        username,
        salt: 'test-salt',
        passwordHash: 'test-hash',
        role,
      });
    }
    store.close();
    store = createStore(databasePath);
    for (const [username, , expectedRole] of [
      ['old-supervisor', 'clinic_supervisor', 'operations_manager'],
      ['old-pho-admin', 'pho_admin', 'operations_manager'],
      ['old-warehouse', 'warehouse_manager', 'operations_manager'],
      ['old-transit-logger', 'transit_logger', 'cold_chain_officer'],
    ]) {
      assert.equal(store.findApplicationUser(username).role, expectedRole);
    }
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local account seeder creates one unique credential for each supported role', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bakunapass-seed-test-'));
  const envPath = path.join(directory, '.env');
  try {
    const accounts = await seedRoleAccounts({
      envPath,
      environment: { NODE_ENV: 'development', HOST: '127.0.0.1' },
    });
    assert.deepEqual(accounts.map(({ role }) => role).sort(), [
      'admin',
      'cold_chain_officer',
      'facility_user',
      'health_worker',
      'operations_manager',
    ]);
    assert.equal(new Set(accounts.map(({ username }) => username)).size, 5);
    assert.ok(accounts.every(({ password }) => password.length >= 12));
    const configuration = parseDotenv(await readFile(envPath, 'utf8'));
    assert.ok(configuration.JWT_SECRET.length >= 32);
    assert.deepEqual(
      JSON.parse(configuration.API_USERS).map(({ username, role }) => ({ username, role })),
      accounts.map(({ username, role }) => ({ username, role })),
    );
    await assert.rejects(
      seedRoleAccounts({
        envPath,
        environment: { NODE_ENV: 'production', HOST: '127.0.0.1' },
      }),
      /only be seeded for a local/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway enforces JWT authentication and role-based access when configured', async () => {
  const apiUsers = [
    { username: 'worker', password: 'worker-password', role: 'health_worker' },
    { username: 'supervisor', password: 'supervisor-password', role: 'clinic_supervisor' },
    { username: 'logger', password: 'logger-password', role: 'transit_logger' },
  ];
  await withApplication({ jwtSecret: 'a-test-signing-secret-that-is-long-enough', apiUsers }, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/v1/requisitions`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, 'AUTH_MISSING_OR_EXPIRED');

    const badLogin = await jsonPost(`${baseUrl}/api/v1/auth/token`, {
      username: 'worker',
      password: 'incorrect',
    });
    assert.equal(badLogin.status, 401);

    const { token: workerToken } = await completeMfaLogin(baseUrl, 'worker', 'worker-password');
    const workerTelemetry = await fetch(`${baseUrl}/api/v1/telemetry`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    assert.equal(workerTelemetry.status, 403);
    const created = await jsonPost(`${baseUrl}/api/v1/requisitions`, {
      clinicId: 'RHU-0101',
      vaccineType: 'Pentavalent (DPT-HepB-Hib)',
      quantity: 20,
    }, { Authorization: `Bearer ${workerToken}` });
    assert.equal(created.status, 201);
    const createdRequisition = await created.json();
    const workerApproval = await fetch(`${baseUrl}/api/v1/requisitions/${createdRequisition.id}/status`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED', vaccineId: 'VAX-1001' }),
    });
    assert.equal(workerApproval.status, 403);

    const { token: supervisorToken, credentials: supervisorCredentials } = await completeMfaLogin(
      baseUrl,
      'supervisor',
      'supervisor-password',
    );
    assert.equal(supervisorCredentials.role, 'operations_manager');
    const supervisorApproval = await fetch(`${baseUrl}/api/v1/requisitions/${createdRequisition.id}/status`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${supervisorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED', vaccineId: 'VAX-1001' }),
    });
    assert.equal(supervisorApproval.status, 200);

    const { token: loggerToken, credentials: loggerCredentials } = await completeMfaLogin(
      baseUrl,
      'logger',
      'logger-password',
    );
    assert.equal(loggerCredentials.role, 'cold_chain_officer');
    const loggerTelemetry = await fetch(`${baseUrl}/api/v1/telemetry`, {
      headers: { Authorization: `Bearer ${loggerToken}` },
    });
    assert.equal(loggerTelemetry.status, 200);

    const reading = await jsonPost(`${baseUrl}/api/v1/telemetry`, {
      vaccineId: 'VAX-1001',
      vaccineName: 'Pentavalent (DPT-HepB-Hib)',
      currentTempCelsius: 4.1,
    }, { Authorization: `Bearer ${loggerToken}` });
    assert.equal(reading.status, 201);

    const unregisteredBatch = await jsonPost(`${baseUrl}/api/v1/telemetry`, {
      vaccineId: 'VAX-UNREGISTERED',
      currentTempCelsius: 4,
    }, { Authorization: `Bearer ${loggerToken}` });
    assert.equal(unregisteredBatch.status, 404);

    const policyChange = await jsonPost(`${baseUrl}/api/v1/telemetry`, telemetry, {
      Authorization: `Bearer ${loggerToken}`,
    });
    assert.equal(policyChange.status, 403);
  });
});

test('five staff roles receive only their intended operational actions', async () => {
  await withAuthenticatedApplication(
    ['facility_user', 'health_worker', 'cold_chain_officer', 'operations_manager', 'admin'],
    {
      weatherProvider: async () => ({
        status: 'AVAILABLE',
        source: 'Open-Meteo',
        cached: false,
        temperatureCelsius: 25,
        humidityPercent: 60,
        observedAt: new Date().toISOString(),
      }),
    },
    async (baseUrl, application, tokens) => {
      const get = (role, route) => fetch(`${baseUrl}/api/v1${route}`, {
        headers: authHeaders(tokens[role]),
      });
      const post = (role, route, payload) => jsonPost(
        `${baseUrl}/api/v1${route}`,
        payload,
        authHeaders(tokens[role]),
      );
      const update = (role, route, payload) => fetch(`${baseUrl}/api/v1${route}`, {
        method: 'PUT',
        headers: { ...authHeaders(tokens[role]), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      for (const role of ['facility_user', 'health_worker']) {
        assert.equal((await get(role, '/requisitions')).status, 200);
        assert.equal((await get(role, '/stock/warehouse/WAREHOUSE-MNL')).status, 200);
        assert.equal((await get(role, '/telemetry')).status, 403);
        assert.equal((await get(role, '/risk-assessment/shipment/SHIP-1001')).status, 403);
        const created = await post(role, '/requisitions', {
          clinicId: role === 'facility_user' ? 'RHU-0101' : 'RHU-0202',
          vaccineType: 'Measles',
          quantity: 10,
        });
        assert.equal(created.status, 201);
      }

      assert.equal((await get('cold_chain_officer', '/telemetry')).status, 200);
      assert.equal((await get('cold_chain_officer', '/risk-assessment/shipment/SHIP-1001')).status, 200);
      assert.equal((await get('cold_chain_officer', '/stock/warehouse/WAREHOUSE-MNL')).status, 403);
      assert.equal((await get('cold_chain_officer', '/requisitions')).status, 403);
      assert.equal((await post('cold_chain_officer', '/telemetry', {
        vaccineId: 'VAX-1001',
        currentTempCelsius: 4.4,
      })).status, 201);
      assert.equal((await get('cold_chain_officer', '/telemetry/VAX-1001')
        .then((response) => response.json())).shipmentId, 'SHIP-1001');
      assert.equal((await post('cold_chain_officer', '/telemetry', {
        vaccineId: 'VAX-NEW',
        currentTempCelsius: 4,
      })).status, 404);
      assert.equal((await post('cold_chain_officer', '/telemetry', telemetry)).status, 403);

      const managerQueue = await get('operations_manager', '/requisitions');
      assert.equal(managerQueue.status, 200);
      assert.equal((await managerQueue.json()).length, 2);
      assert.equal((await get('operations_manager', '/telemetry')).status, 200);
      assert.equal((await get('operations_manager', '/stock/warehouse/WAREHOUSE-MNL')).status, 200);
      assert.equal((await get('operations_manager', '/risk-assessment/shipment/SHIP-1001')).status, 200);
      assert.equal((await post('operations_manager', '/requisitions', {
        clinicId: 'RHU-0303',
        vaccineType: 'BCG',
        quantity: 5,
      })).status, 403);
      assert.equal((await post('operations_manager', '/telemetry', {
        vaccineId: 'VAX-1001',
        currentTempCelsius: 4,
      })).status, 403);
      const reservation = await post('operations_manager', '/stock/reserve', {
        vaccineId: 'VAX-1001',
        quantity: 1,
      });
      assert.equal(reservation.status, 200);

      const pending = await post('facility_user', '/requisitions', {
        clinicId: 'RHU-0101',
        vaccineType: 'BCG',
        quantity: 4,
      });
      const pendingRequest = await pending.json();
      assert.equal(pendingRequest.status, 'PENDING');
      assert.equal((await update('operations_manager', `/requisitions/${pendingRequest.id}/status`, {
        status: 'HOLD',
      })).status, 200);

      for (const route of [
        '/requisitions',
        '/telemetry',
        '/stock/warehouse/WAREHOUSE-MNL',
        '/risk-assessment/shipment/SHIP-1001',
      ]) {
        assert.equal((await get('admin', route)).status, 200);
      }
      assert.equal((await get('admin', '/admin/accounts')).status, 200);
      assert.equal((await post('admin', '/requisitions', {
        clinicId: 'RHU-0404',
        vaccineType: 'BCG',
        quantity: 1,
      })).status, 403);
      assert.equal((await post('admin', '/telemetry', {
        vaccineId: 'VAX-1001',
        currentTempCelsius: 4,
      })).status, 403);
      assert.equal((await post('admin', '/stock/reserve', {
        vaccineId: 'VAX-1001',
        quantity: 1,
      })).status, 403);
      assert.equal((await update('admin', `/requisitions/${pendingRequest.id}/status`, {
        status: 'REJECTED',
      })).status, 403);
      assert.equal((await get('health_worker', '/admin/accounts')).status, 403);
    },
  );
});

test('sign-in requires authenticator enrollment, a fresh code, and one-use recovery codes', async () => {
  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'secure-worker', password: 'secure-worker-password', role: 'health_worker' }],
  }, async (baseUrl) => {
    const passwordStep = await jsonPost(`${baseUrl}/api/v1/auth/token`, {
      username: 'secure-worker',
      password: 'secure-worker-password',
    });
    assert.equal(passwordStep.status, 202);
    assert.equal((await passwordStep.json()).enrollmentRequired, true);
    const setupCookie = passwordStep.headers.get('set-cookie').split(';')[0];

    const setup = await jsonPost(`${baseUrl}/api/v1/auth/mfa/setup`, {}, { Cookie: setupCookie });
    assert.equal(setup.status, 200);
    const { secret, otpauthUrl } = await setup.json();
    assert.match(otpauthUrl, /^otpauth:\/\/totp\/BakunaPass/);
    const invalid = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
      code: 'invalid',
    }, { Cookie: setupCookie });
    assert.equal(invalid.status, 401);

    const enrolled = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
      code: createTotpCode(secret),
    }, { Cookie: setupCookie });
    assert.equal(enrolled.status, 200);
    const enrollmentResult = await enrolled.json();
    assert.equal(enrollmentResult.recoveryCodes.length, 10);

    const challenge = await jsonPost(`${baseUrl}/api/v1/auth/token`, {
      username: 'secure-worker',
      password: 'secure-worker-password',
    });
    assert.equal(challenge.status, 202);
    assert.equal((await challenge.json()).enrollmentRequired, false);
    const challengeCookie = challenge.headers.get('set-cookie').split(';')[0];
    const nextStepTimestamp = (Math.floor(Date.now() / 30_000) + 1) * 30_000;
    const verified = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
      code: createTotpCode(secret, nextStepTimestamp),
    }, { Cookie: challengeCookie });
    assert.equal(verified.status, 200);
    assert.ok((await verified.json()).token);
    const reusedChallenge = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
      code: enrollmentResult.recoveryCodes[1],
    }, { Cookie: challengeCookie });
    assert.equal(reusedChallenge.status, 401);
    assert.equal((await reusedChallenge.json()).error, 'MFA_SESSION_EXPIRED');

    const recoveryChallenge = await jsonPost(`${baseUrl}/api/v1/auth/token`, {
      username: 'secure-worker',
      password: 'secure-worker-password',
    });
    const recoveryCookie = recoveryChallenge.headers.get('set-cookie').split(';')[0];
    const recovery = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
      code: enrollmentResult.recoveryCodes[0],
    }, { Cookie: recoveryCookie });
    assert.equal(recovery.status, 200);

    const replayChallenge = await jsonPost(`${baseUrl}/api/v1/auth/token`, {
      username: 'secure-worker',
      password: 'secure-worker-password',
    });
    const replayCookie = replayChallenge.headers.get('set-cookie').split(';')[0];
    const replayed = await jsonPost(`${baseUrl}/api/v1/auth/mfa/verify`, {
      code: enrollmentResult.recoveryCodes[0],
    }, { Cookie: replayCookie });
    assert.equal(replayed.status, 401);
  });
});

test('health workers can only track requisitions submitted by their own account', async () => {
  const apiUsers = [
    { username: 'worker-one', password: 'worker-one-password', role: 'health_worker' },
    { username: 'worker-two', password: 'worker-two-password', role: 'health_worker' },
    { username: 'platform-admin', password: 'platform-admin-password', role: 'admin' },
  ];
  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers,
  }, async (baseUrl) => {
    async function tokenFor(username, password) {
      return (await completeMfaLogin(baseUrl, username, password)).token;
    }

    const workerOneToken = await tokenFor('worker-one', 'worker-one-password');
    const workerTwoToken = await tokenFor('worker-two', 'worker-two-password');
    const adminToken = await tokenFor('platform-admin', 'platform-admin-password');
    async function submit(token, clinicId) {
      const response = await jsonPost(`${baseUrl}/api/v1/requisitions`, {
        clinicId,
        vaccineType: 'Measles',
        quantity: 10,
      }, {
        Authorization: `Bearer ${token}`,
        'X-BakunaPass-User': 'forged-user',
      });
      assert.equal(response.status, 201);
      return response.json();
    }

    const firstRequest = await submit(workerOneToken, 'RHU-0101');
    const secondRequest = await submit(workerTwoToken, 'RHU-0202');
    const ownListResponse = await fetch(`${baseUrl}/api/v1/requisitions`, {
      headers: { Authorization: `Bearer ${workerOneToken}` },
    });
    const ownRequests = await ownListResponse.json();
    assert.equal(ownRequests.length, 1);
    assert.equal(ownRequests[0].id, firstRequest.id);
    assert.equal(ownRequests[0].submittedBy, 'worker-one');

    const privateRequest = await fetch(`${baseUrl}/api/v1/requisitions/${secondRequest.id}`, {
      headers: { Authorization: `Bearer ${workerOneToken}` },
    });
    assert.equal(privateRequest.status, 404);

    const allRequests = await fetch(`${baseUrl}/api/v1/requisitions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal((await allRequests.json()).length, 2);
  });
});

test('gateway rate limits API traffic and enforces its configured CORS origin', async () => {
  await withApplication({
    apiRateLimit: { limit: 1, windowMs: 60_000 },
    allowedOrigin: 'https://trusted.example',
  }, async (baseUrl) => {
    const deniedOrigin = await fetch(`${baseUrl}/api/v1/telemetry/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example' },
    });
    assert.equal(deniedOrigin.status, 403);

    const allowedOrigin = await fetch(`${baseUrl}/api/v1/telemetry/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://trusted.example' },
    });
    assert.equal(allowedOrigin.status, 204);
    assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'https://trusted.example');

    assert.equal((await fetch(`${baseUrl}/api/v1/telemetry/health`)).status, 200);
    const limited = await fetch(`${baseUrl}/api/v1/telemetry/health`);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'RATE_LIMITED');
  });
});

test('Open-Meteo provider requests current weather, caches successful responses, and reports provider errors', async () => {
  let calls = 0;
  let queryUrl;
  const provider = createOpenMeteoProvider({
    now: () => 1_800_000_000_000,
    fetchImpl: async (url) => {
      calls += 1;
      queryUrl = new URL(url);
      return {
        ok: true,
        async json() {
          return {
            current: {
              temperature_2m: 34,
              relative_humidity_2m: 70,
              time: '2027-01-15T08:00',
            },
            current_units: { temperature_2m: '°C', relative_humidity_2m: '%' },
          };
        },
      };
    },
  });
  const first = await provider({ latitude: 14.5995, longitude: 120.9842 });
  const second = await provider({ latitude: 14.5995, longitude: 120.9842 });
  assert.equal(first.status, 'AVAILABLE');
  assert.equal(first.temperatureCelsius, 34);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.equal(queryUrl.hostname, 'api.open-meteo.com');
  assert.equal(queryUrl.searchParams.get('current'), 'temperature_2m,relative_humidity_2m');

  const unavailable = createOpenMeteoProvider({
    fetchImpl: async () => { throw new Error('Network unavailable'); },
  });
  assert.equal((await unavailable({ latitude: 14.5, longitude: 121 })).status, 'UNAVAILABLE');
});

test('protected pages and APIs have no local demo bypass', async () => {
  await withApplication({}, async (baseUrl) => {
    const configuration = await fetch(`${baseUrl}/api/v1/auth/config`);
    assert.deepEqual(await configuration.json(), {
      loginEnabled: false,
      registrationEnabled: false,
      mfaRequired: true,
    });
    const demo = await fetch(`${baseUrl}/api/v1/auth/demo`, { method: 'POST' });
    assert.equal(demo.status, 405);
    assert.equal((await fetch(`${baseUrl}/api/v1/requisitions`)).status, 401);
    const workspace = await fetch(`${baseUrl}/workspace`, { redirect: 'manual' });
    assert.equal(workspace.status, 302);
    assert.equal(workspace.headers.get('location'), '/auth.html');
  });

  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'worker', password: 'worker-password', role: 'health_worker' }],
  }, async (baseUrl) => {
    const demo = await fetch(`${baseUrl}/api/v1/auth/demo`, { method: 'POST' });
    assert.equal(demo.status, 405);
  });
});

test('registration creates a facility user and admins can assign its operational role', async () => {
  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'platform-admin', password: 'platform-admin-password', role: 'admin' }],
  }, async (baseUrl) => {
    const unavailableRegistration = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: 'a-long-password-value',
        fullName: 'New Staff Member',
        email: 'new-worker@health.gov',
        facility: 'RHU-0101',
        staffId: 'STAFF-0101',
        jobTitle: 'Public health nurse / midwife',
      }),
    });
    assert.equal(unavailableRegistration.status, 201);
    const newAccount = await unavailableRegistration.json();
    assert.equal(newAccount.status, 'ACTIVE');
    assert.equal(newAccount.role, 'facility_user');
    assert.equal(newAccount.facility, 'RHU-0101');
    const { token: facilityToken } = await completeMfaLogin(baseUrl, 'new-worker@health.gov', 'a-long-password-value');
    const ownRequest = await jsonPost(`${baseUrl}/api/v1/requisitions`, {
      clinicId: 'RHU-0101',
      vaccineType: 'BCG',
      quantity: 5,
    }, authHeaders(facilityToken));
    assert.equal(ownRequest.status, 201);
    const personalQueue = await fetch(`${baseUrl}/api/v1/requisitions`, {
      headers: authHeaders(facilityToken),
    });
    assert.equal((await personalQueue.json()).length, 1);
    const restrictedTelemetry = await fetch(`${baseUrl}/api/v1/telemetry`, {
      headers: authHeaders(facilityToken),
    });
    assert.equal(restrictedTelemetry.status, 403);
    const stockView = await fetch(`${baseUrl}/api/v1/stock/warehouse/WAREHOUSE-MNL`, {
      headers: authHeaders(facilityToken),
    });
    assert.equal(stockView.status, 200);

    const { token: adminToken } = await completeMfaLogin(baseUrl, 'platform-admin', 'platform-admin-password');
    const accounts = await fetch(`${baseUrl}/api/v1/admin/accounts`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(accounts.status, 200);
    const accountList = await accounts.json();
    const newWorkerUsername = accountList[0].username;
    assert.equal(accountList[0].fullName, 'New Staff Member');
    assert.equal(accountList[0].email, 'new-worker@health.gov');
    assert.equal(accountList[0].role, 'facility_user');
    assert.equal(accountList[0].status, 'ACTIVE');

    const forbiddenReview = await fetch(`${baseUrl}/api/v1/admin/accounts/${encodeURIComponent(newWorkerUsername)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'SET_ROLE', role: 'health_worker' }),
    });
    assert.equal(forbiddenReview.status, 403);
    const approval = await fetch(`${baseUrl}/api/v1/admin/accounts/${encodeURIComponent(newWorkerUsername)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'SET_ROLE', role: 'admin' }),
    });
    assert.equal(approval.status, 400);
    const roleChange = await fetch(`${baseUrl}/api/v1/admin/accounts/${encodeURIComponent(newWorkerUsername)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'SET_ROLE', role: 'health_worker' }),
    });
    assert.equal(roleChange.status, 200);
    assert.equal((await roleChange.json()).role, 'health_worker');
    const oldRoleSession = await fetch(`${baseUrl}/api/v1/requisitions`, {
      headers: authHeaders(facilityToken),
    });
    assert.equal(oldRoleSession.status, 401);
    const { response: login, credentials } = await completeMfaLogin(baseUrl, 'new-worker@health.gov', 'a-long-password-value');
    assert.equal(credentials.role, 'health_worker');
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    const session = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: authHeaders(credentials.token),
    });
    assert.equal((await session.json()).fullName, 'New Staff Member');

    const created = await jsonPost(`${baseUrl}/api/v1/requisitions`, {
      clinicId: 'RHU-0101',
      vaccineType: 'BCG',
      quantity: 5,
    }, { Authorization: `Bearer ${credentials.token}` });
    assert.equal(created.status, 201);

    const duplicate = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'another-long-password',
      fullName: 'New Staff Member',
      email: 'new-worker@health.gov',
      facility: 'RHU-0101',
      staffId: 'STAFF-0101',
      jobTitle: 'Public health nurse / midwife',
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'ACCOUNT_ALREADY_EXISTS');
    const duplicateEmail = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'another-long-password',
      fullName: 'Different Staff Member',
      email: 'new-worker@health.gov',
      facility: 'RHU-0202',
      staffId: 'STAFF-0202',
      jobTitle: 'Public health nurse / midwife',
    });
    assert.equal(duplicateEmail.status, 409);
    assert.equal((await duplicateEmail.json()).details.field, 'email');

    const duplicateStaffId = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'another-long-password',
      fullName: 'Another Staff Member',
      email: 'another-worker@health.gov',
      facility: 'RHU-0202',
      staffId: 'STAFF-0101',
      jobTitle: 'Public health nurse / midwife',
    });
    assert.equal(duplicateStaffId.status, 409);
    assert.equal((await duplicateStaffId.json()).details.field, 'staffId');

    const suspended = await fetch(`${baseUrl}/api/v1/admin/accounts/${encodeURIComponent(newWorkerUsername)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'SUSPEND' }),
    });
    assert.equal(suspended.status, 200);
    assert.equal((await suspended.json()).status, 'SUSPENDED');
    assert.equal((await fetch(`${baseUrl}/api/v1/requisitions`, {
      headers: authHeaders(credentials.token),
    })).status, 401);
    const blockedLogin = await jsonPost(`${baseUrl}/api/v1/auth/token`, {
      username: 'new-worker@health.gov',
      password: 'a-long-password-value',
    });
    assert.equal(blockedLogin.status, 403);
    assert.equal((await blockedLogin.json()).error, 'ACCOUNT_NOT_ACTIVE');

    const reactivated = await fetch(`${baseUrl}/api/v1/admin/accounts/${encodeURIComponent(newWorkerUsername)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ACTIVATE' }),
    });
    assert.equal(reactivated.status, 200);
    assert.equal((await reactivated.json()).status, 'ACTIVE');
    const restored = await completeMfaLogin(baseUrl, 'new-worker@health.gov', 'a-long-password-value');
    assert.equal(restored.credentials.role, 'health_worker');
  });
});

test('self-registered facility accounts persist through a service restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bakunapass-auth-test-'));
  const databasePath = path.join(directory, 'auth.sqlite');
  const options = {
    gatewayPort: 0,
    requisitionPort: 0,
    telemetryPort: 0,
    legacyAdapterPort: 0,
    legacySoapPort: 0,
    mashupPort: 0,
    databasePath,
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'platform-admin', password: 'platform-admin-password', role: 'admin' }],
  };
  let application;
  try {
    application = await startBakunaPass(options);
    const registered = await jsonPost(`${application.gatewayUrl}/api/v1/auth/register`, {
      password: 'persisted-worker-password',
      fullName: 'Persisted Staff',
      email: 'persisted@health.gov',
      facility: 'RHU-0202',
      staffId: 'STAFF-0202',
      jobTitle: 'Public health nurse / midwife',
    });
    assert.equal(registered.status, 201);
    await application.close();
    application = await startBakunaPass(options);
    const { credentials } = await completeMfaLogin(
      application.gatewayUrl,
      'persisted@health.gov',
      'persisted-worker-password',
    );
    assert.equal(credentials.role, 'facility_user');
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration validates account fields and always assigns the least-privilege role', async () => {
  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'platform-admin', password: 'platform-admin-password', role: 'admin' }],
  }, async (baseUrl) => {
    const invalid = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'too-short',
      role: 'admin',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'INVALID_FORMAT');
    const unavailable = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'a-valid-long-password',
      role: 'pho_admin',
      fullName: 'Health Worker',
      email: 'worker@health.gov',
      facility: 'RHU-0101',
      staffId: 'STAFF-0101',
      jobTitle: 'Public health nurse / midwife',
    });
    assert.equal(unavailable.status, 201);
    assert.equal((await unavailable.json()).role, 'facility_user');
  });

  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'worker-only', password: 'worker-only-password', role: 'health_worker' }],
  }, async (baseUrl) => {
    const configuration = await fetch(`${baseUrl}/api/v1/auth/config`);
    assert.equal((await configuration.json()).registrationEnabled, false);
    const registration = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'a-valid-long-password',
      fullName: 'New Staff Member',
      email: 'new-worker@health.gov',
      facility: 'RHU-0101',
      staffId: 'STAFF-0101',
      jobTitle: 'Public health nurse / midwife',
    });
    assert.equal(registration.status, 503);
  });

  await withApplication({
    jwtSecret: 'a-test-signing-secret-that-is-long-enough',
    apiUsers: [{ username: 'platform-admin', password: 'platform-admin-password', role: 'admin' }],
  }, async (baseUrl) => {
    const unsupportedTitle = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'a-valid-long-password',
      fullName: 'Unlisted Staff',
      email: 'unlisted@health.gov',
      facility: 'RHU-0101',
      staffId: 'STAFF-0999',
      jobTitle: 'Administrator',
    });
    assert.equal(unsupportedTitle.status, 400);
    assert.equal((await unsupportedTitle.json()).details.field, 'jobTitle');
  });

  await withApplication({}, async (baseUrl) => {
    const disabled = await jsonPost(`${baseUrl}/api/v1/auth/register`, {
      password: 'a-valid-long-password',
    });
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).error, 'AUTHENTICATION_NOT_CONFIGURED');
  });
});

test('non-loopback deployment refuses to start without gateway credentials', async () => {
  await assert.rejects(
    startBakunaPass({
      host: '0.0.0.0',
      gatewayPort: 0,
      requisitionPort: 0,
      telemetryPort: 0,
      legacyAdapterPort: 0,
      legacySoapPort: 0,
      mashupPort: 0,
      databasePath: ':memory:',
      jwtSecret: '',
      apiUsers: '',
    }),
    /requires JWT_SECRET and API_USERS/,
  );
});

test('stepped load profile runs against a local backend service and reports latency and failures', async () => {
  const app = await startBakunaPass({
    gatewayPort: 0,
    requisitionPort: 0,
    telemetryPort: 0,
    legacyAdapterPort: 0,
    legacySoapPort: 0,
    mashupPort: 0,
    databasePath: ':memory:',
  });
  try {
    const result = await runLoadProfile({
      targetUrl: `${app.serviceUrls.requisitions}/health`,
      durationSeconds: 1,
      concurrencyLevels: [1, 3],
    });
    assert.equal(result.stages.length, 2);
    for (const stage of result.stages) {
      assert.ok(stage.requests > 0);
      assert.equal(stage.failures, 0);
      assert.ok(stage.latencyMs.p95 >= stage.latencyMs.p50);
    }
  } finally {
    await app.close();
  }
});

test('load test refuses public targets and invalid load profiles', async () => {
  await assert.rejects(
    runLoadTest({ targetUrl: 'https://example.com/health', durationSeconds: 1, concurrency: 1 }),
    /restricted to local loopback/,
  );
  await assert.rejects(
    runLoadTest({ targetUrl: 'http://127.0.0.1:5001/health', durationSeconds: 0, concurrency: 1 }),
    /Duration must be/,
  );
  await assert.rejects(
    runLoadProfile({ targetUrl: 'http://127.0.0.1:5001/health', concurrencyLevels: [5, 2] }),
    /strictly increasing/,
  );
});
