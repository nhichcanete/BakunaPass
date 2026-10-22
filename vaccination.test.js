import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPatientNotification,
  calculateVaccinationStatus,
  deleteEntry,
  exportRecordsToCsv,
  resolveNotificationChannel,
  updateEntry,
} from './vaccination.js';

test('returns not vaccinated when no doses are recorded', () => {
  const result = calculateVaccinationStatus({ doses: 0, referenceDate: new Date('2026-09-30') });

  assert.equal(result.status, 'Not vaccinated');
  assert.equal(result.valid, false);
});

test('flags a single dose as partially vaccinated', () => {
  const result = calculateVaccinationStatus({
    doses: 1,
    referenceDate: new Date('2026-09-30'),
  });

  assert.equal(result.status, 'Partially vaccinated');
  assert.equal(result.valid, false);
});

test('accepts a fully vaccinated record within the valid window', () => {
  const result = calculateVaccinationStatus({
    doses: 2,
    lastDoseDate: '2026-05-01',
    referenceDate: new Date('2026-09-30'),
  });

  assert.equal(result.status, 'Fully vaccinated');
  assert.equal(result.valid, true);
});

test('requires a booster after 180 days', () => {
  const result = calculateVaccinationStatus({
    doses: 2,
    lastDoseDate: '2026-01-01',
    referenceDate: new Date('2026-09-30'),
  });

  assert.equal(result.status, 'Booster due');
  assert.equal(result.valid, false);
});

test('normalizes string values before evaluating booster and dose status', () => {
  const due = calculateVaccinationStatus({
    doses: '2',
    lastDoseDate: '2026-01-01',
    boosterReceived: 'false',
    referenceDate: '2026-09-30',
  });

  const complete = calculateVaccinationStatus({
    doses: '3',
    lastDoseDate: '2026-06-01',
    boosterReceived: 'true',
    referenceDate: '2026-09-30',
  });

  assert.equal(due.status, 'Booster due');
  assert.equal(complete.status, 'Booster complete');
});

test('marks a booster record as valid', () => {
  const result = calculateVaccinationStatus({
    doses: 3,
    lastDoseDate: '2026-06-01',
    boosterReceived: true,
    referenceDate: new Date('2026-09-30'),
  });

  assert.equal(result.status, 'Booster complete');
  assert.equal(result.valid, true);
});

test('updates a resident record in place', () => {
  const entries = [
    { name: 'Maria Santos', doses: 2, lastDoseDate: '2026-06-15', boosterReceived: false },
    { name: 'John Cena', doses: 1, lastDoseDate: '2026-09-10', boosterReceived: false },
  ];

  const result = updateEntry(entries, 0, {
    name: 'Maria Dela Cruz',
    doses: 3,
    lastDoseDate: '2026-08-12',
    boosterReceived: true,
  });

  assert.deepEqual(result[0], {
    name: 'Maria Dela Cruz',
    doses: 3,
    lastDoseDate: '2026-08-12',
    boosterReceived: true,
  });
});

test('deletes a resident record by index', () => {
  const entries = [
    { name: 'Maria Santos', doses: 2, lastDoseDate: '2026-06-15', boosterReceived: false },
    { name: 'John Cena', doses: 1, lastDoseDate: '2026-09-10', boosterReceived: false },
  ];

  const result = deleteEntry(entries, 0);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'John Cena');
});

test('exports records to CSV with headers and values', () => {
  const entries = [
    { name: 'Maria Santos', doses: 2, lastDoseDate: '2026-06-15', boosterReceived: false },
  ];

  const csv = exportRecordsToCsv(entries);

  assert.match(csv, /name,doses,lastDoseDate,boosterReceived/);
  assert.match(csv, /Maria Santos,2,2026-06-15,false/);
});

test('builds a patient notification message when booster follow-up is required', () => {
  const message = buildPatientNotification({
    name: 'Maria Santos',
    address: '123 Sampaloc St, Manila',
    email: 'maria@example.com',
    phone: '09171234567',
    doses: 2,
    lastDoseDate: '2026-01-01',
    boosterReceived: false,
    referenceDate: '2026-09-30',
  });

  assert.match(message, /Maria Santos/i);
  assert.match(message, /booster/i);
  assert.match(message, /123 Sampaloc St, Manila/i);
  assert.match(message, /maria@example.com/i);
});

test('prefers email delivery when the patient has an email address', () => {
  const channel = resolveNotificationChannel({
    name: 'Maria Santos',
    email: 'maria@example.com',
    phone: '09171234567',
  });

  assert.equal(channel, 'email');
});
