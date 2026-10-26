import crypto from 'node:crypto';
import http from 'node:http';

const maxBodySize = 64 * 1024;

function sendJson(response, statusCode, data, correlationId) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Correlation-ID': correlationId,
  });
  response.end(JSON.stringify(data));
}

function sendError(response, statusCode, code, message, details, correlationId) {
  sendJson(response, statusCode, {
    error: code,
    message,
    details,
    timestamp: new Date().toISOString(),
    correlationId,
  }, correlationId);
}

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

function unescapeXml(value) {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, entity) => ({
    lt: '<',
    gt: '>',
    amp: '&',
    quot: '"',
    apos: "'",
  })[entity]);
}

function validateXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return 'Document type declarations and entities are not supported.';
  }
  const stack = [];
  let roots = 0;
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?xml[^?]*\?>|<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (/^<\?xml\b/i.test(token) || /^<!--[\s\S]*-->$/.test(token)) {
      continue;
    }
    if (!token.startsWith('<')) {
      if (!stack.length && token.trim()) {
        return 'Text outside the XML root element is not allowed.';
      }
      continue;
    }
    const closing = /^<\/([A-Za-z][\w-]*)\s*>$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) {
        return 'XML tags are not properly nested.';
      }
      continue;
    }
    const opening = /^<([A-Za-z][\w-]*)(?:\s[^<>]*)?\s*(\/?)>$/.exec(token);
    if (!opening) {
      return 'The XML document contains an invalid tag.';
    }
    if (!stack.length) {
      roots += 1;
    }
    if (!/\/\s*>$/.test(token)) {
      stack.push(opening[1]);
    }
  }
  if (stack.length || roots !== 1) {
    return 'The XML document is incomplete.';
  }
  return null;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function xmlField(xml, field) {
  const match = new RegExp(`<${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${field}>`, 'i').exec(xml);
  return match ? unescapeXml(match[1].trim()) : undefined;
}

function parseTelemetryXml(xml) {
  const invalidXml = validateXml(xml);
  if (invalidXml) {
    return { error: 'MALFORMED_PAYLOAD', message: invalidXml };
  }
  const range = /<safeRangeCelsius\b([^>]*)\/?>/i.exec(xml);
  const rangeMin = range && /\bmin=["']([^"']+)["']/i.exec(range[1]);
  const rangeMax = range && /\bmax=["']([^"']+)["']/i.exec(range[1]);
  return {
    payload: {
      vaccineId: xmlField(xml, 'vaccineId'),
      vaccineName: xmlField(xml, 'vaccineName'),
      currentTempCelsius: xmlField(xml, 'currentTempCelsius'),
      safeMinCelsius: rangeMin?.[1] ?? xmlField(xml, 'safeMinCelsius'),
      safeMaxCelsius: rangeMax?.[1] ?? xmlField(xml, 'safeMaxCelsius'),
      coldChainStatus: xmlField(xml, 'coldChainStatus'),
      humidityPercent: xmlField(xml, 'humidityPercent'),
      shipmentId: xmlField(xml, 'shipmentId'),
      latitude: xmlField(xml, 'latitude'),
      longitude: xmlField(xml, 'longitude'),
      lastCheckedAt: xmlField(xml, 'lastCheckedAt'),
    },
  };
}

function telemetryToXml(batch) {
  const optional = (key, value) => value === null || value === undefined
    ? ''
    : `  <${key}>${escapeXml(value)}</${key}>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<vaccineBatch>
  <vaccineId>${escapeXml(batch.vaccineId)}</vaccineId>
  <vaccineName>${escapeXml(batch.vaccineName)}</vaccineName>
  <currentTempCelsius>${escapeXml(batch.currentTempCelsius)}</currentTempCelsius>
  <safeRangeCelsius min="${escapeXml(batch.safeMinCelsius)}" max="${escapeXml(batch.safeMaxCelsius)}" />
  <coldChainStatus>${escapeXml(batch.coldChainStatus)}</coldChainStatus>
${optional('humidityPercent', batch.humidityPercent)}${optional('shipmentId', batch.shipmentId)}${optional('latitude', batch.latitude)}${optional('longitude', batch.longitude)}  <lastCheckedAt>${escapeXml(batch.lastCheckedAt)}</lastCheckedAt>
</vaccineBatch>`;
}

function wantsXml(request) {
  const accepted = String(request.headers.accept || '')
    .split(',')
    .map((entry) => {
      const [type, ...parameters] = entry.trim().toLowerCase().split(';');
      const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
      return [type.trim(), quality ? Number(quality.trim().slice(2)) : 1];
    });
  const qualityFor = (type) => accepted.find(([acceptedType]) => acceptedType === type)?.[1] || 0;
  return qualityFor('application/xml') > qualityFor('application/json')
    && qualityFor('application/xml') > 0;
}

function sendTelemetry(response, statusCode, batch, xml, correlationId) {
  if (xml) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/xml; charset=utf-8',
      'X-Correlation-ID': correlationId,
    });
    response.end(telemetryToXml(batch));
    return;
  }
  sendJson(response, statusCode, toTelemetryResource(batch), correlationId);
}

function toTelemetryResource(batch) {
  return {
    vaccineId: batch.vaccineId,
    vaccineName: batch.vaccineName,
    currentTempCelsius: batch.currentTempCelsius,
    safeRangeCelsius: {
      min: batch.safeMinCelsius,
      max: batch.safeMaxCelsius,
    },
    coldChainStatus: batch.coldChainStatus,
    ...(batch.humidityPercent === null || batch.humidityPercent === undefined ? {} : { humidityPercent: batch.humidityPercent }),
    ...(batch.shipmentId ? { shipmentId: batch.shipmentId } : {}),
    ...(batch.latitude === null || batch.latitude === undefined ? {} : { latitude: batch.latitude }),
    ...(batch.longitude === null || batch.longitude === undefined ? {} : { longitude: batch.longitude }),
    lastCheckedAt: batch.lastCheckedAt,
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodySize) {
      const error = new Error('Request body exceeds the 64 KB limit.');
      error.statusCode = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseRequestBody(request) {
  const body = await readBody(request);
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') {
    try {
      return { payload: JSON.parse(body), format: 'json' };
    } catch {
      return { error: 'MALFORMED_PAYLOAD', message: 'The request body contains invalid JSON syntax.' };
    }
  }
  if (contentType === 'application/xml' || contentType === 'text/xml') {
    const parsed = parseTelemetryXml(body);
    return { ...parsed, format: 'xml' };
  }
  return { error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json or application/xml.' };
}

function validateTelemetry(payload, existingBatch) {
  const vaccineId = String(payload?.vaccineId ?? '').trim();
  const vaccineName = String(payload?.vaccineName ?? existingBatch?.vaccineName ?? '').trim();
  const temperature = Number(payload?.currentTempCelsius);
  const suppliedMinimum = payload?.safeRangeCelsius?.min ?? payload?.safeMinCelsius;
  const suppliedMaximum = payload?.safeRangeCelsius?.max ?? payload?.safeMaxCelsius;
  const hasSuppliedRange = payload?.safeRangeCelsius !== undefined
    || payload?.safeMinCelsius !== undefined
    || payload?.safeMaxCelsius !== undefined;
  const minimum = existingBatch ? existingBatch.safeMinCelsius : Number(suppliedMinimum);
  const maximum = existingBatch ? existingBatch.safeMaxCelsius : Number(suppliedMaximum);
  const humidityPercent = payload?.humidityPercent === undefined || payload?.humidityPercent === ''
    ? undefined
    : Number(payload.humidityPercent);
  const latitude = payload?.latitude === undefined || payload?.latitude === ''
    ? undefined
    : Number(payload.latitude);
  const longitude = payload?.longitude === undefined || payload?.longitude === ''
    ? undefined
    : Number(payload.longitude);

  if (!vaccineId || !/^[A-Z0-9][A-Z0-9_-]{2,63}$/i.test(vaccineId)) {
    return { error: 'MISSING_REQUIRED_FIELD', field: 'vaccineId', message: 'A valid vaccineId is required.' };
  }
  if (!vaccineName || vaccineName.length > 120) {
    return { error: 'MISSING_REQUIRED_FIELD', field: 'vaccineName', message: 'A vaccineName of 1 to 120 characters is required.' };
  }
  if (existingBatch && vaccineName.toLowerCase() !== existingBatch.vaccineName.toLowerCase()) {
    return {
      error: 'BATCH_VACCINE_MISMATCH',
      statusCode: 409,
      field: 'vaccineName',
      message: 'The telemetry vaccine name cannot change for an existing batch.',
    };
  }
  if (existingBatch && hasSuppliedRange
    && (Number(suppliedMinimum) !== existingBatch.safeMinCelsius || Number(suppliedMaximum) !== existingBatch.safeMaxCelsius)) {
    return {
      error: 'SAFE_RANGE_IMMUTABLE',
      statusCode: 409,
      field: 'safeRangeCelsius',
      message: 'An existing batch safe range cannot be changed through telemetry ingestion.',
    };
  }
  if (!Number.isFinite(temperature) || temperature < -100 || temperature > 100) {
    return { error: 'INVALID_FORMAT', field: 'currentTempCelsius', message: 'Temperature must be a number from -100 to 100.' };
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
    return { error: 'INVALID_FORMAT', field: 'safeRangeCelsius', message: 'A valid safe temperature range with min less than or equal to max is required.' };
  }
  if (humidityPercent !== undefined && (!Number.isFinite(humidityPercent) || humidityPercent < 0 || humidityPercent > 100)) {
    return { error: 'INVALID_FORMAT', field: 'humidityPercent', message: 'Humidity must be a number from 0 to 100.' };
  }
  if (latitude !== undefined && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    return { error: 'INVALID_FORMAT', field: 'latitude', message: 'Latitude must be from -90 to 90.' };
  }
  if (longitude !== undefined && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    return { error: 'INVALID_FORMAT', field: 'longitude', message: 'Longitude must be from -180 to 180.' };
  }

  const lastCheckedAt = payload?.lastCheckedAt ? String(payload.lastCheckedAt) : new Date().toISOString();
  if (Number.isNaN(Date.parse(lastCheckedAt))) {
    return { error: 'INVALID_FORMAT', field: 'lastCheckedAt', message: 'lastCheckedAt must be a valid ISO-8601 date.' };
  }
  return {
    value: {
      vaccineId,
      vaccineName,
      temperature,
      minimum,
      maximum,
      humidityPercent,
      shipmentId: payload?.shipmentId ? String(payload.shipmentId).trim() : undefined,
      latitude,
      longitude,
      recordedAt: lastCheckedAt,
    },
  };
}

function validateRequisition(payload) {
  const clinicId = String(payload?.clinicId ?? '').trim();
  const vaccineType = String(payload?.vaccineType ?? '').trim();
  const quantity = Number(payload?.quantity);
  const vaccineId = payload?.vaccineId ? String(payload.vaccineId).trim() : undefined;
  const telemetryFormat = String(payload?.telemetryFormat || 'json').toLowerCase();

  if (!/^(?:CLN|RHU)-[A-Z0-9-]{2,20}$/i.test(clinicId)) {
    return { error: clinicId ? 'INVALID_FORMAT' : 'MISSING_REQUIRED_FIELD', field: 'clinicId', message: 'A valid clinicId such as CLN-014 or RHU-0101 is required.' };
  }
  if (!vaccineType || vaccineType.length > 100) {
    return { error: 'MISSING_REQUIRED_FIELD', field: 'vaccineType', message: 'A vaccineType of 1 to 100 characters is required.' };
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
    return { error: 'INVALID_FORMAT', field: 'quantity', message: 'quantity must be a whole number from 1 to 100000.' };
  }
  if (vaccineId && !/^[A-Z0-9][A-Z0-9_-]{2,63}$/i.test(vaccineId)) {
    return { error: 'INVALID_FORMAT', field: 'vaccineId', message: 'vaccineId has an invalid format.' };
  }
  if (!['json', 'xml'].includes(telemetryFormat)) {
    return { error: 'INVALID_ENUM', field: 'telemetryFormat', message: 'telemetryFormat must be json or xml.' };
  }
  return { value: { clinicId, vaccineType, quantity, vaccineId, telemetryFormat } };
}

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

export function createServiceServer({ service, store, telemetryUrl = '' }) {
  if (!['requisitions', 'telemetry'].includes(service)) {
    throw new TypeError(`Unknown service: ${service}`);
  }

  return http.createServer(async (request, response) => {
    const correlationId = String(request.headers['x-correlation-id'] || crypto.randomUUID());
    const pathname = normalizePath(new URL(request.url, 'http://localhost').pathname);

    if (request.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/api/health')) {
      return sendJson(response, 200, { status: 'UP', service }, correlationId);
    }

    if (service === 'telemetry' && pathname === '/telemetry' && request.method === 'GET') {
      return sendJson(response, 200, store.listBatches().map(toTelemetryResource), correlationId);
    }

    if (service === 'telemetry' && pathname === '/telemetry/alerts' && request.method === 'GET') {
      return sendJson(response, 200, store.listBatches()
        .filter((batch) => batch.coldChainStatus === 'BREACH')
        .map(toTelemetryResource), correlationId);
    }

    if (service === 'telemetry' && pathname === '/telemetry' && request.method === 'POST') {
      try {
        const parsed = await parseRequestBody(request);
        if (parsed.error) {
          return sendError(response, parsed.error === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400, parsed.error, parsed.message, parsed.field ? { field: parsed.field } : {}, correlationId);
        }
        const existingBatch = store.findBatch(String(parsed.payload?.vaccineId ?? '').trim());
        const authenticatedRole = String(request.headers['x-bakunapass-role'] || '');
        const suppliesSafeRange = parsed.payload?.safeRangeCelsius !== undefined
          || parsed.payload?.safeMinCelsius !== undefined
          || parsed.payload?.safeMaxCelsius !== undefined;
        if (authenticatedRole === 'cold_chain_officer' && suppliesSafeRange) {
          return sendError(response, 403, 'FORBIDDEN', 'Cold-chain officers may submit readings only; they cannot set batch identity or safe-range policy.', {}, correlationId);
        }
        if (authenticatedRole === 'cold_chain_officer' && !existingBatch) {
          return sendError(response, 404, 'RESOURCE_NOT_FOUND', 'Cold-chain officers can only submit readings for a registered batch.', {
            resource: 'TelemetryBatch',
            batchId: parsed.payload?.vaccineId ?? null,
          }, correlationId);
        }
        const validation = validateTelemetry(parsed.payload, existingBatch);
        if (validation.error) {
          return sendError(response, validation.statusCode || 400, validation.error, validation.message, { field: validation.field }, correlationId);
        }
        const batch = store.recordTelemetry(validation.value);
        return sendTelemetry(response, 201, batch, wantsXml(request) || parsed.format === 'xml', correlationId);
      } catch (error) {
        const status = error.statusCode || 500;
        return sendError(response, status, error.code || 'INTERNAL_ERROR', error.message, {}, correlationId);
      }
    }

    if (service === 'telemetry' && pathname.startsWith('/telemetry/')) {
      const suffix = pathname.slice('/telemetry/'.length).split('/');
      const vaccineId = decodePathSegment(suffix[0]);
      if (!vaccineId) {
        return sendError(response, 400, 'INVALID_FORMAT', 'The vaccineId path segment is malformed.', {}, correlationId);
      }
      const batch = store.findBatch(vaccineId);
      if (!batch) {
        return sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested vaccine telemetry batch record could not be found.', { resource: 'TelemetryBatch', batchId: vaccineId }, correlationId);
      }
      if (request.method === 'GET' && suffix[1] === 'history') {
        return sendJson(response, 200, store.getTelemetryHistory(vaccineId), correlationId);
      }
      if (request.method === 'GET' && suffix.length === 1) {
        return sendTelemetry(response, 200, batch, wantsXml(request), correlationId);
      }
    }

    if (service === 'requisitions' && pathname === '/requisitions' && request.method === 'GET') {
      if (['health_worker', 'facility_user'].includes(request.headers['x-bakunapass-role'])) {
        const username = String(request.headers['x-bakunapass-user'] || '');
        if (!username) {
          return sendError(response, 401, 'AUTH_MISSING_OR_EXPIRED', 'A verified account is required to view personal requisitions.', {}, correlationId);
        }
        return sendJson(response, 200, store.listRequisitionsBySubmitter(username), correlationId);
      }
      return sendJson(response, 200, store.listRequisitions(), correlationId);
    }

    if (service === 'requisitions' && pathname === '/requisitions' && request.method === 'POST') {
      try {
        const parsed = await parseRequestBody(request);
        if (parsed.error) {
          return sendError(response, parsed.error === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400, parsed.error, parsed.message, {}, correlationId);
        }
        if (parsed.format !== 'json') {
          return sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Requisitions must be submitted as application/json.', { expected: 'application/json' }, correlationId);
        }
        const validation = validateRequisition(parsed.payload);
        if (validation.error) {
          return sendError(response, 400, validation.error, validation.message, { field: validation.field }, correlationId);
        }

        let status = 'PENDING';
        let telemetryStatus;
        if (validation.value.vaccineId) {
          try {
            const upstream = await fetch(`${telemetryUrl}/telemetry/${encodeURIComponent(validation.value.vaccineId)}`, {
              headers: {
                Accept: validation.value.telemetryFormat === 'xml' ? 'application/xml' : 'application/json',
                'X-Correlation-ID': correlationId,
              },
              signal: AbortSignal.timeout(3000),
            });
            if (upstream.status === 404) {
              return sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The assigned vaccine batch does not exist in the cold-chain telemetry service.', { resource: 'TelemetryBatch', vaccineId: validation.value.vaccineId }, correlationId);
            }
            if (!upstream.ok) {
              return sendError(response, 503, 'SERVICE_UNAVAILABLE', 'The cold-chain telemetry service could not verify the vaccine batch.', { targetService: 'Vaccine Cold-Chain Telemetry Service' }, correlationId);
            }
            let telemetry;
            if (validation.value.telemetryFormat === 'xml') {
              const parsed = parseTelemetryXml(await upstream.text());
              if (parsed.error) {
                return sendError(response, 502, 'UPSTREAM_ERROR', 'The telemetry service returned invalid XML.', { targetService: 'Vaccine Cold-Chain Telemetry Service' }, correlationId);
              }
              telemetry = parsed.payload;
            } else {
              telemetry = await upstream.json();
            }
            telemetryStatus = telemetry.coldChainStatus;
            if (!['OK', 'BREACH'].includes(telemetryStatus)) {
              return sendError(response, 502, 'UPSTREAM_ERROR', 'The telemetry service returned an invalid cold-chain status.', { targetService: 'Vaccine Cold-Chain Telemetry Service' }, correlationId);
            }
            if (String(telemetry.vaccineName).trim().toLowerCase() !== validation.value.vaccineType.toLowerCase()) {
              return sendError(response, 409, 'BATCH_VACCINE_MISMATCH', 'The selected batch does not match the requested vaccine type.', {
                vaccineId: validation.value.vaccineId,
                requestedVaccineType: validation.value.vaccineType,
                batchVaccineType: telemetry.vaccineName,
              }, correlationId);
            }
            status = telemetryStatus === 'BREACH' ? 'REJECTED' : 'APPROVED';
          } catch {
            return sendError(response, 503, 'SERVICE_UNAVAILABLE', 'The cold-chain telemetry service is unavailable; the requisition was not created.', { targetService: 'Vaccine Cold-Chain Telemetry Service' }, correlationId);
          }
        }

        const { telemetryFormat, ...requisitionInput } = validation.value;
        const submittedBy = String(request.headers['x-bakunapass-user'] || '').trim() || undefined;
        const requisition = store.createRequisition({ ...requisitionInput, status, telemetryStatus, submittedBy });
        if (status === 'REJECTED') {
          return sendJson(response, 409, {
            error: 'COLD_CHAIN_BREACH',
            message: 'Requisition rejected because the assigned vaccine batch has a cold-chain breach.',
            details: { requisition, batchId: validation.value.vaccineId, coldChainStatus: telemetryStatus },
            timestamp: new Date().toISOString(),
            correlationId,
          }, correlationId);
        }
        response.writeHead(201, {
          'Content-Type': 'application/json; charset=utf-8',
          'Location': `/requisitions/${encodeURIComponent(requisition.id)}`,
          'X-Correlation-ID': correlationId,
        });
        response.end(JSON.stringify(requisition));
        return;
      } catch (error) {
        const status = error.statusCode || 500;
        return sendError(response, status, error.code || 'INTERNAL_ERROR', error.message, {}, correlationId);
      }
    }

    const requisitionMatch = /^\/requisitions\/([^/]+)(?:\/status)?$/.exec(pathname);
    if (service === 'requisitions' && requisitionMatch && request.method === 'GET' && !pathname.endsWith('/status')) {
      const requisitionId = decodePathSegment(requisitionMatch[1]);
      if (!requisitionId) {
        return sendError(response, 400, 'INVALID_FORMAT', 'The requisition id path segment is malformed.', {}, correlationId);
      }
      const requisition = store.findRequisition(requisitionId);
      if (requisition && ['health_worker', 'facility_user'].includes(request.headers['x-bakunapass-role'])
        && requisition.submittedBy?.toLowerCase() !== String(request.headers['x-bakunapass-user'] || '').toLowerCase()) {
        return sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested requisition does not exist.', { requisitionId }, correlationId);
      }
      return requisition
        ? sendJson(response, 200, requisition, correlationId)
        : sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested requisition does not exist.', { requisitionId }, correlationId);
    }
    if (service === 'requisitions' && requisitionMatch && pathname.endsWith('/status') && ['PUT', 'PATCH'].includes(request.method)) {
      try {
        const parsed = await parseRequestBody(request);
        const status = String(parsed.payload?.status || '').toUpperCase();
        if (parsed.error) {
          return sendError(response, parsed.error === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400, parsed.error, parsed.message, {}, correlationId);
        }
        if (!['APPROVED', 'REJECTED', 'HOLD'].includes(status)) {
          return sendError(response, 400, 'INVALID_ENUM', 'status must be APPROVED, REJECTED, or HOLD.', { field: 'status' }, correlationId);
        }
        const requisitionId = decodePathSegment(requisitionMatch[1]);
        if (!requisitionId) {
          return sendError(response, 400, 'INVALID_FORMAT', 'The requisition id path segment is malformed.', {}, correlationId);
        }
        const current = store.findRequisition(requisitionId);
        if (!current) {
          return sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested requisition does not exist.', { requisitionId }, correlationId);
        }
        const assignedVaccineId = parsed.payload?.vaccineId
          ? String(parsed.payload.vaccineId).trim()
          : current.vaccineId;
        if (parsed.payload?.vaccineId
          && !/^[A-Z0-9][A-Z0-9_-]{2,63}$/i.test(assignedVaccineId)) {
          return sendError(response, 400, 'INVALID_FORMAT', 'vaccineId has an invalid format.', { field: 'vaccineId' }, correlationId);
        }
        if (status === 'APPROVED' && !assignedVaccineId) {
          return sendError(response, 409, 'BATCH_REQUIRED', 'Assign and verify a vaccine batch before approving this requisition.', { requisitionId }, correlationId);
        }
        if (assignedVaccineId && (status === 'APPROVED' || assignedVaccineId !== current.vaccineId)) {
          try {
            const upstream = await fetch(`${telemetryUrl}/telemetry/${encodeURIComponent(assignedVaccineId)}`, {
              headers: { Accept: 'application/json', 'X-Correlation-ID': correlationId },
              signal: AbortSignal.timeout(3000),
            });
            if (upstream.status === 404) {
              return sendError(response, 409, 'BATCH_NOT_FOUND', 'The assigned vaccine batch is no longer available for verification.', { vaccineId: assignedVaccineId }, correlationId);
            }
            if (!upstream.ok) {
              return sendError(response, 503, 'SERVICE_UNAVAILABLE', 'The cold-chain telemetry service could not verify the vaccine batch.', { targetService: 'Vaccine Cold-Chain Telemetry Service' }, correlationId);
            }
            const batch = await upstream.json();
            if (String(batch.vaccineName).trim().toLowerCase() !== current.vaccineType.toLowerCase()) {
              return sendError(response, 409, 'BATCH_VACCINE_MISMATCH', 'The selected batch does not match the requested vaccine type.', {
                vaccineId: assignedVaccineId,
                requestedVaccineType: current.vaccineType,
                batchVaccineType: batch.vaccineName,
              }, correlationId);
            }
            if (status === 'APPROVED' && batch.coldChainStatus !== 'OK') {
              return sendError(response, 409, 'COLD_CHAIN_BREACH', 'The requisition cannot be approved because its assigned batch has a cold-chain breach.', {
                vaccineId: assignedVaccineId,
                coldChainStatus: batch.coldChainStatus,
              }, correlationId);
            }
          } catch {
            return sendError(response, 503, 'SERVICE_UNAVAILABLE', 'The cold-chain telemetry service is unavailable; requisition status was not changed.', { targetService: 'Vaccine Cold-Chain Telemetry Service' }, correlationId);
          }
        }
        const requisition = store.updateRequisitionStatus(requisitionId, status, assignedVaccineId);
        return requisition
          ? sendJson(response, 200, requisition, correlationId)
          : sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested requisition does not exist.', { requisitionId: decodeURIComponent(requisitionMatch[1]) }, correlationId);
      } catch (error) {
        const status = error.statusCode || 500;
        return sendError(response, status, error.code || 'INTERNAL_ERROR', error.message, {}, correlationId);
      }
    }

    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') {
      return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'The requested method is not supported.', {}, correlationId);
    }
    return sendError(response, 404, 'RESOURCE_NOT_FOUND', 'The requested service resource does not exist.', { path: pathname }, correlationId);
  });
}

export function parseTelemetryXmlRequest(xml) {
  return parseTelemetryXml(xml);
}
