function normalizeDoseCount(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function normalizeBoosterStatus(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'n', ''].includes(normalized)) {
      return false;
    }
  }

  return false;
}

export function toDaysDifference(startDate, endDate) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((endDate - startDate) / msPerDay);
}

export function calculateVaccinationStatus({
  doses = 0,
  lastDoseDate = null,
  boosterReceived = false,
  referenceDate = new Date(),
} = {}) {
  const normalizedDoseCount = normalizeDoseCount(doses);
  const hasBooster = normalizeBoosterStatus(boosterReceived);

  if (normalizedDoseCount <= 0) {
    return {
      status: 'Not vaccinated',
      valid: false,
      message: 'No vaccine dose has been recorded yet.',
    };
  }

  if (normalizedDoseCount === 1) {
    return {
      status: 'Partially vaccinated',
      valid: false,
      message: 'A second dose is still needed to complete the primary series.',
    };
  }

  if (hasBooster) {
    return {
      status: 'Booster complete',
      valid: true,
      message: 'Booster dose is on file and the pass remains valid.',
    };
  }

  if (!lastDoseDate) {
    return {
      status: 'Fully vaccinated',
      valid: true,
      message: 'Primary vaccination is complete, but the last dose date is missing.',
    };
  }

  const reference = new Date(referenceDate);
  const lastDose = new Date(lastDoseDate);

  if (Number.isNaN(lastDose.getTime())) {
    return {
      status: 'Fully vaccinated',
      valid: true,
      message: 'Primary vaccination is complete, but the date could not be read.',
    };
  }

  const dayDifference = toDaysDifference(lastDose, reference);

  if (dayDifference > 180) {
    return {
      status: 'Booster due',
      valid: false,
      message: 'The booster window has passed; a booster dose is recommended.',
    };
  }

  return {
    status: 'Fully vaccinated',
    valid: true,
    message: 'The resident is currently within the valid vaccination window.',
  };
}

export function summarizeEntries(entries = [], referenceDate = new Date()) {
  return entries.reduce(
    (summary, entry) => {
      const result = calculateVaccinationStatus({
        doses: entry.doses,
        lastDoseDate: entry.lastDoseDate,
        boosterReceived: entry.boosterReceived,
        referenceDate,
      });

      summary.total += 1;
      summary[result.valid ? 'valid' : 'pending'] += 1;
      return summary;
    },
    { total: 0, valid: 0, pending: 0 },
  );
}

export function getPassExpiryDate(lastDoseDate, boosterReceived = false) {
  if (!lastDoseDate) {
    return null;
  }

  const date = new Date(lastDoseDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const normalizedBoosterState = normalizeBoosterStatus(boosterReceived);
  const daysToReview = normalizedBoosterState ? 180 : 180;
  date.setDate(date.getDate() + daysToReview);
  return date.toISOString().slice(0, 10);
}

export function exportRecordsToCsv(entries = []) {
  const headers = ['name', 'doses', 'lastDoseDate', 'boosterReceived', 'address', 'phone', 'email'];
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => [
    entry.name ?? '',
    entry.doses ?? 0,
    entry.lastDoseDate ?? '',
    Boolean(entry.boosterReceived),
    entry.address ?? '',
    entry.phone ?? '',
    entry.email ?? '',
  ]);

  const escapeCsvValue = (value) => {
    const stringValue = String(value ?? '');
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  const content = [headers, ...rows]
    .map((row) => row.map(escapeCsvValue).join(','))
    .join('\n');

  return `${content}\n`;
}

export function resolveNotificationChannel(entry = {}) {
  const email = String(entry.email || '').trim();
  const phone = String(entry.phone || '').trim();

  if (email && /\S+@\S+\.\S+/.test(email)) {
    return 'email';
  }

  if (phone) {
    return 'sms';
  }

  return 'copy';
}

export function buildNotificationDelivery(entry = {}, message = '') {
  const finalMessage = message || buildPatientNotification(entry);
  const channel = resolveNotificationChannel(entry);

  return {
    channel,
    target: String(entry.email || entry.phone || '').trim(),
    message: finalMessage,
    subject: 'BakunaPass Health Notification',
  };
}

export function buildPatientNotification(entry = {}, referenceDate = new Date()) {
  const result = calculateVaccinationStatus({
    doses: entry.doses,
    lastDoseDate: entry.lastDoseDate,
    boosterReceived: entry.boosterReceived,
    referenceDate,
  });

  const name = entry.name || 'Patient';
  const address = entry.address || 'No address on file';
  const email = entry.email || 'No email on file';
  const phone = entry.phone || 'No phone number on file';

  if (result.status === 'Booster due') {
    return `Dear ${name}, your booster review is now due. Please attend the nearest health facility as soon as possible. We have your address on file at ${address}. Contact: ${email} / ${phone}.`;
  }

  if (result.status === 'Partially vaccinated') {
    return `Dear ${name}, your vaccination record is incomplete. Please complete your second dose and bring your vaccination card. We have your address on file at ${address}. Contact: ${email} / ${phone}.`;
  }

  if (result.status === 'Not vaccinated') {
    return `Dear ${name}, no vaccine record is currently available. Please register for vaccination at the nearest local clinic. We have your address on file at ${address}. Contact: ${email} / ${phone}.`;
  }

  return `Dear ${name}, your vaccination status is currently ${result.status}. Please keep your record updated and maintain regular follow-up. Contact: ${email} / ${phone}.`;
}

export function updateEntry(entries = [], index, nextEntry = {}) {
  if (!Array.isArray(entries) || index < 0 || index >= entries.length) {
    return [...entries];
  }

  const updated = { ...entries[index], ...nextEntry };
  const nextEntries = [...entries];
  nextEntries[index] = updated;
  return nextEntries;
}

export function deleteEntry(entries = [], index) {
  if (!Array.isArray(entries) || index < 0 || index >= entries.length) {
    return [...entries];
  }

  return entries.filter((_, entryIndex) => entryIndex !== index);
}
