import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const demoBatches = [
  ['VAX-1001', 'Pentavalent (DPT-HepB-Hib)', 4.2, 2, 8, 'OK'],
  ['VAX-1002', 'Measles', 10.5, 2, 8, 'BREACH'],
  ['VAX-1003', 'BCG', 3.8, 2, 8, 'OK'],
];

export function createStore(filename = ':memory:') {
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  const database = new DatabaseSync(filename);

  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS telemetry_batches (
      vaccine_id TEXT PRIMARY KEY,
      vaccine_name TEXT NOT NULL,
      current_temp_celsius REAL NOT NULL,
      safe_min_celsius REAL NOT NULL,
      safe_max_celsius REAL NOT NULL,
      cold_chain_status TEXT NOT NULL,
      humidity_percent REAL,
      shipment_id TEXT,
      latitude REAL,
      longitude REAL,
      last_checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telemetry_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vaccine_id TEXT NOT NULL REFERENCES telemetry_batches(vaccine_id),
      temperature_celsius REAL NOT NULL,
      humidity_percent REAL,
      cold_chain_status TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telemetry_history_batch_date
      ON telemetry_history(vaccine_id, recorded_at);
    CREATE TABLE IF NOT EXISTS requisitions (
      id TEXT PRIMARY KEY,
      clinic_id TEXT NOT NULL,
      vaccine_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      vaccine_id TEXT,
      status TEXT NOT NULL,
      telemetry_status TEXT,
      submitted_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_inventory (
      vaccine_id TEXT PRIMARY KEY,
      vaccine_name TEXT NOT NULL,
      warehouse_code TEXT NOT NULL,
      stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0),
      expiration_date TEXT NOT NULL,
      safe_min_celsius REAL NOT NULL,
      safe_max_celsius REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      full_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      facility TEXT NOT NULL DEFAULT '',
      staff_id TEXT NOT NULL DEFAULT '',
      job_title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mfa_credentials (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      encrypted_secret TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      backup_code_hashes TEXT NOT NULL DEFAULT '[]',
      last_accepted_step INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS mfa_challenges (
      challenge_id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);

  const requisitionColumns = database.prepare('PRAGMA table_info(requisitions)').all();
  if (!requisitionColumns.some(({ name }) => name === 'submitted_by')) {
    database.exec('ALTER TABLE requisitions ADD COLUMN submitted_by TEXT');
  }
  database.exec('CREATE INDEX IF NOT EXISTS requisitions_submitter_date ON requisitions(submitted_by, created_at DESC)');
  const userColumns = database.prepare('PRAGMA table_info(application_users)').all();
  if (!userColumns.some(({ name }) => name === 'status')) {
    database.exec("ALTER TABLE application_users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'");
  }
  for (const [name, definition] of [
    ['full_name', "TEXT NOT NULL DEFAULT ''"],
    ['email', "TEXT NOT NULL DEFAULT ''"],
    ['facility', "TEXT NOT NULL DEFAULT ''"],
    ['staff_id', "TEXT NOT NULL DEFAULT ''"],
    ['job_title', "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!userColumns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE application_users ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(`
    UPDATE application_users
    SET role = 'operations_manager'
    WHERE role IN ('clinic_supervisor', 'pho_admin', 'warehouse_manager');
    UPDATE application_users
    SET role = 'cold_chain_officer'
    WHERE role = 'transit_logger';
  `);

  const batchCount = database.prepare('SELECT COUNT(*) AS count FROM telemetry_batches').get().count;
  if (batchCount === 0) {
    const insertBatch = database.prepare(`
      INSERT INTO telemetry_batches (
        vaccine_id, vaccine_name, current_temp_celsius, safe_min_celsius,
        safe_max_celsius, cold_chain_status, last_checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertHistory = database.prepare(`
      INSERT INTO telemetry_history (vaccine_id, temperature_celsius, cold_chain_status, recorded_at)
      VALUES (?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const [id, name, temperature, minimum, maximum, status] of demoBatches) {
      insertBatch.run(id, name, temperature, minimum, maximum, status, now);
      insertHistory.run(id, temperature, status, now);
    }
  }

  const seedShipment = database.prepare(`
    UPDATE telemetry_batches
    SET shipment_id = COALESCE(shipment_id, ?),
        latitude = COALESCE(latitude, 14.5995),
        longitude = COALESCE(longitude, 120.9842)
    WHERE vaccine_id = ?
  `);
  for (const [vaccineId, shipmentId] of [
    ['VAX-1001', 'SHIP-1001'],
    ['VAX-1002', 'SHIP-1002'],
    ['VAX-1003', 'SHIP-1003'],
  ]) {
    seedShipment.run(shipmentId, vaccineId);
  }

  const inventoryCount = database.prepare('SELECT COUNT(*) AS count FROM legacy_inventory').get().count;
  if (inventoryCount === 0) {
    const addInventory = database.prepare(`
      INSERT INTO legacy_inventory (
        vaccine_id, vaccine_name, warehouse_code, stock_quantity,
        expiration_date, safe_min_celsius, safe_max_celsius
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    addInventory.run('VAX-1001', 'Pentavalent (DPT-HepB-Hib)', 'WAREHOUSE-MNL', 500, '2027-12-31', 2, 8);
    addInventory.run('VAX-1002', 'Measles', 'WAREHOUSE-MNL', 250, '2027-06-30', 2, 8);
    addInventory.run('VAX-1003', 'BCG', 'WAREHOUSE-MNL', 800, '2028-03-31', 2, 8);
  }

  return {
    close: () => database.close(),
    createApplicationUser({
      username,
      salt,
      passwordHash,
      role,
      status = 'ACTIVE',
      fullName = '',
      email = '',
      facility = '',
      staffId = '',
      jobTitle = '',
    }) {
      database.prepare(`
        INSERT INTO application_users (
          username, salt, password_hash, role, status, full_name, email, facility,
          staff_id, job_title, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(username, salt, passwordHash, role, status, fullName, email, facility, staffId, jobTitle, new Date().toISOString());
    },
    findApplicationUser(username) {
      return database.prepare(`
        SELECT username, salt, password_hash AS passwordHash, role, status,
          full_name AS fullName
        FROM application_users WHERE username = ? COLLATE NOCASE
      `).get(username);
    },
    findApplicationUserByEmail(email) {
      return database.prepare(`
        SELECT username FROM application_users WHERE email = ? COLLATE NOCASE
      `).get(email);
    },
    findApplicationUserByStaffId(staffId) {
      return database.prepare(`
        SELECT username FROM application_users WHERE staff_id = ? COLLATE NOCASE
      `).get(staffId);
    },
    listApplicationUsers() {
      return database.prepare(`
        SELECT username, role, status, full_name AS fullName,
          email, facility, staff_id AS staffId, job_title AS jobTitle,
          created_at AS createdAt
        FROM application_users
        WHERE status IN ('ACTIVE', 'PENDING', 'SUSPENDED')
        ORDER BY created_at
      `).all();
    },
    updateApplicationUser(username, { status, role }) {
      const result = database.prepare(`
        UPDATE application_users SET status = ?, role = ?
        WHERE username = ? COLLATE NOCASE AND status IN ('ACTIVE', 'PENDING', 'SUSPENDED')
      `).run(status, role, username);
      return result.changes ? database.prepare(`
        SELECT username, role, status, full_name AS fullName,
          email, facility, staff_id AS staffId, job_title AS jobTitle,
          created_at AS createdAt
        FROM application_users WHERE username = ? COLLATE NOCASE
      `).get(username) : undefined;
    },
    findMfaCredential(username) {
      return database.prepare(`
        SELECT username, encrypted_secret AS encryptedSecret,
          secret_iv AS secretIv, secret_tag AS secretTag, enabled,
          backup_code_hashes AS backupCodeHashes,
          last_accepted_step AS lastAcceptedStep
        FROM mfa_credentials WHERE username = ? COLLATE NOCASE
      `).get(username);
    },
    savePendingMfa(username, { encryptedSecret, secretIv, secretTag }) {
      database.prepare(`
        INSERT INTO mfa_credentials (
          username, encrypted_secret, secret_iv, secret_tag, enabled,
          backup_code_hashes, last_accepted_step
        ) VALUES (?, ?, ?, ?, 0, '[]', -1)
        ON CONFLICT(username) DO UPDATE SET
          encrypted_secret = excluded.encrypted_secret,
          secret_iv = excluded.secret_iv,
          secret_tag = excluded.secret_tag,
          enabled = 0,
          backup_code_hashes = '[]',
          last_accepted_step = -1
        WHERE mfa_credentials.enabled = 0
      `).run(username, encryptedSecret, secretIv, secretTag);
    },
    enableMfa(username, { backupCodeHashes, acceptedStep }) {
      return database.prepare(`
        UPDATE mfa_credentials SET enabled = 1,
          backup_code_hashes = ?, last_accepted_step = ?
        WHERE username = ? COLLATE NOCASE AND enabled = 0
      `).run(JSON.stringify(backupCodeHashes), acceptedStep, username).changes > 0;
    },
    consumeMfaStep(username, acceptedStep) {
      return database.prepare(`
        UPDATE mfa_credentials SET last_accepted_step = ?
        WHERE username = ? COLLATE NOCASE AND enabled = 1
          AND last_accepted_step < ?
      `).run(acceptedStep, username, acceptedStep).changes > 0;
    },
    consumeBackupCode(username, codeHash) {
      const credential = this.findMfaCredential(username);
      if (!credential?.enabled) {
        return false;
      }
      const hashes = JSON.parse(credential.backupCodeHashes);
      const index = hashes.indexOf(codeHash);
      if (index < 0) {
        return false;
      }
      hashes.splice(index, 1);
      database.prepare(`
        UPDATE mfa_credentials SET backup_code_hashes = ?
        WHERE username = ? COLLATE NOCASE AND enabled = 1
      `).run(JSON.stringify(hashes), username);
      return true;
    },
    createMfaChallenge({ challengeId, username, scope, expiresAt }) {
      const now = Math.floor(Date.now() / 1000);
      database.prepare('DELETE FROM mfa_challenges WHERE expires_at <= ? OR consumed = 1').run(now);
      database.prepare(`
        INSERT INTO mfa_challenges (challenge_id, username, scope, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(challengeId, username, scope, expiresAt);
    },
    consumeMfaChallenge({ challengeId, username, scope }) {
      return database.prepare(`
        UPDATE mfa_challenges SET consumed = 1
        WHERE challenge_id = ? AND username = ? COLLATE NOCASE AND scope = ?
          AND expires_at > ? AND consumed = 0
      `).run(challengeId, username, scope, Math.floor(Date.now() / 1000)).changes > 0;
    },
    findBatch(vaccineId) {
      return database.prepare(`
        SELECT vaccine_id AS vaccineId, vaccine_name AS vaccineName,
          current_temp_celsius AS currentTempCelsius,
          safe_min_celsius AS safeMinCelsius, safe_max_celsius AS safeMaxCelsius,
          cold_chain_status AS coldChainStatus, humidity_percent AS humidityPercent,
          shipment_id AS shipmentId, latitude, longitude, last_checked_at AS lastCheckedAt
        FROM telemetry_batches WHERE vaccine_id = ?
      `).get(vaccineId);
    },
    listBatches() {
      return database.prepare(`
        SELECT vaccine_id AS vaccineId, vaccine_name AS vaccineName,
          current_temp_celsius AS currentTempCelsius,
          safe_min_celsius AS safeMinCelsius, safe_max_celsius AS safeMaxCelsius,
          cold_chain_status AS coldChainStatus, humidity_percent AS humidityPercent,
          shipment_id AS shipmentId, latitude, longitude, last_checked_at AS lastCheckedAt
        FROM telemetry_batches ORDER BY vaccine_id
      `).all();
    },
    findBatchByShipmentId(shipmentId) {
      return database.prepare(`
        SELECT vaccine_id AS vaccineId, vaccine_name AS vaccineName,
          current_temp_celsius AS currentTempCelsius,
          safe_min_celsius AS safeMinCelsius, safe_max_celsius AS safeMaxCelsius,
          cold_chain_status AS coldChainStatus, humidity_percent AS humidityPercent,
          shipment_id AS shipmentId, latitude, longitude, last_checked_at AS lastCheckedAt
        FROM telemetry_batches WHERE shipment_id = ?
      `).get(shipmentId);
    },
    recordTelemetry({ vaccineId, vaccineName, temperature, minimum, maximum, humidityPercent, shipmentId, latitude, longitude, recordedAt }) {
      const readingStatus = temperature < minimum || temperature > maximum ? 'BREACH' : 'OK';
      const upsert = database.prepare(`
        INSERT INTO telemetry_batches (
          vaccine_id, vaccine_name, current_temp_celsius, safe_min_celsius,
          safe_max_celsius, cold_chain_status, humidity_percent, shipment_id,
          latitude, longitude, last_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vaccine_id) DO UPDATE SET
          vaccine_name = excluded.vaccine_name,
          current_temp_celsius = excluded.current_temp_celsius,
          safe_min_celsius = excluded.safe_min_celsius,
          safe_max_celsius = excluded.safe_max_celsius,
          cold_chain_status = excluded.cold_chain_status,
          humidity_percent = excluded.humidity_percent,
          shipment_id = COALESCE(excluded.shipment_id, telemetry_batches.shipment_id),
          latitude = COALESCE(excluded.latitude, telemetry_batches.latitude),
          longitude = COALESCE(excluded.longitude, telemetry_batches.longitude),
          last_checked_at = excluded.last_checked_at
      `);
      const history = database.prepare(`
        INSERT INTO telemetry_history (vaccine_id, temperature_celsius, humidity_percent, cold_chain_status, recorded_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      database.exec('BEGIN IMMEDIATE');
      try {
        const priorBreach = database.prepare(`
          SELECT 1 FROM telemetry_history
          WHERE vaccine_id = ? AND cold_chain_status = 'BREACH'
          LIMIT 1
        `).get(vaccineId);
        const batchStatus = readingStatus === 'BREACH' || priorBreach ? 'BREACH' : 'OK';
        upsert.run(
          vaccineId,
          vaccineName,
          temperature,
          minimum,
          maximum,
          batchStatus,
          humidityPercent ?? null,
          shipmentId ?? null,
          latitude ?? null,
          longitude ?? null,
          recordedAt,
        );
        history.run(vaccineId, temperature, humidityPercent ?? null, readingStatus, recordedAt);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return this.findBatch(vaccineId);
    },
    getTelemetryHistory(vaccineId) {
      return database.prepare(`
        SELECT temperature_celsius AS temperatureCelsius,
          humidity_percent AS humidityPercent, cold_chain_status AS coldChainStatus,
          recorded_at AS recordedAt
        FROM telemetry_history WHERE vaccine_id = ? ORDER BY recorded_at DESC, id DESC
      `).all(vaccineId);
    },
    createRequisition({ clinicId, vaccineType, quantity, vaccineId, status, telemetryStatus, submittedBy }) {
      const id = `REQ-${cryptoRandomId()}`;
      const createdAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO requisitions (id, clinic_id, vaccine_type, quantity, vaccine_id, status, telemetry_status, submitted_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, clinicId, vaccineType, quantity, vaccineId ?? null, status, telemetryStatus ?? null, submittedBy ?? null, createdAt);
      return this.findRequisition(id);
    },
    findRequisition(id) {
      return database.prepare(`
        SELECT id, clinic_id AS clinicId, vaccine_type AS vaccineType, quantity,
          vaccine_id AS vaccineId, status, telemetry_status AS telemetryStatus,
          submitted_by AS submittedBy, created_at AS createdAt
        FROM requisitions WHERE id = ?
      `).get(id);
    },
    listRequisitions() {
      return database.prepare(`
        SELECT id, clinic_id AS clinicId, vaccine_type AS vaccineType, quantity,
          vaccine_id AS vaccineId, status, telemetry_status AS telemetryStatus,
          submitted_by AS submittedBy, created_at AS createdAt
        FROM requisitions ORDER BY created_at DESC
      `).all();
    },
    listRequisitionsBySubmitter(username) {
      return database.prepare(`
        SELECT id, clinic_id AS clinicId, vaccine_type AS vaccineType, quantity,
          vaccine_id AS vaccineId, status, telemetry_status AS telemetryStatus,
          submitted_by AS submittedBy, created_at AS createdAt
        FROM requisitions WHERE submitted_by = ? COLLATE NOCASE
        ORDER BY created_at DESC
      `).all(username);
    },
    updateRequisitionStatus(id, status, vaccineId) {
      const result = database.prepare(`
        UPDATE requisitions
        SET status = ?, vaccine_id = COALESCE(?, vaccine_id)
        WHERE id = ?
      `).run(status, vaccineId || null, id);
      return result.changes ? this.findRequisition(id) : undefined;
    },
    findLegacyInventory(vaccineId) {
      return database.prepare(`
        SELECT vaccine_id AS vaccineId, vaccine_name AS vaccineName,
          warehouse_code AS warehouseCode, stock_quantity AS stockQuantity,
          expiration_date AS expirationDate, safe_min_celsius AS safeMinCelsius,
          safe_max_celsius AS safeMaxCelsius
        FROM legacy_inventory WHERE vaccine_id = ?
      `).get(vaccineId);
    },
    listLegacyInventory(warehouseCode) {
      return database.prepare(`
        SELECT vaccine_id AS vaccineId, vaccine_name AS vaccineName,
          warehouse_code AS warehouseCode, stock_quantity AS stockQuantity,
          expiration_date AS expirationDate, safe_min_celsius AS safeMinCelsius,
          safe_max_celsius AS safeMaxCelsius
        FROM legacy_inventory
        WHERE warehouse_code = ? ORDER BY vaccine_name, vaccine_id
      `).all(warehouseCode);
    },
    reserveLegacyInventory(vaccineId, quantity) {
      const result = database.prepare(`
        UPDATE legacy_inventory SET stock_quantity = stock_quantity - ?
        WHERE vaccine_id = ? AND stock_quantity >= ?
      `).run(quantity, vaccineId, quantity);
      return result.changes ? this.findLegacyInventory(vaccineId) : undefined;
    },
  };
}

function cryptoRandomId() {
  return randomUUID();
}
