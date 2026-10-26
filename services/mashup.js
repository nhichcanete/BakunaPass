import crypto from 'node:crypto';
import http from 'node:http';

const weatherCacheMs = 5 * 60_000;
const telemetryMaxAgeMs = 15 * 60_000;

function sendJson(response, status, body, correlationId) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Correlation-ID': correlationId,
  });
  response.end(JSON.stringify(body));
}

function errorResponse(response, status, error, message, details, correlationId) {
  return sendJson(response, status, {
    error,
    message,
    details,
    timestamp: new Date().toISOString(),
    correlationId,
  }, correlationId);
}

function parseWeather(data) {
  const temperature = Number(data?.current?.temperature_2m);
  const humidity = Number(data?.current?.relative_humidity_2m);
  const observedAt = data?.current?.time;
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)
    || typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
    throw new TypeError('Open-Meteo returned an incomplete weather response.');
  }
  return {
    temperatureCelsius: temperature,
    humidityPercent: humidity,
    observedAt,
    units: {
      temperature: data.current_units?.temperature_2m || '°C',
      humidity: data.current_units?.relative_humidity_2m || '%',
    },
  };
}

export function createOpenMeteoProvider({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function getWeather({ latitude, longitude }) {
    const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const cached = cache.get(key);
    if (cached && now() - cached.fetchedAt < weatherCacheMs) {
      return {
        status: 'AVAILABLE',
        source: 'Open-Meteo',
        cached: true,
        ...cached.data,
      };
    }

    const query = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: 'temperature_2m,relative_humidity_2m',
      timezone: 'UTC',
    });
    try {
      const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${query}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`Open-Meteo returned HTTP ${response.status}.`);
      }
      const data = parseWeather(await response.json());
      cache.set(key, { data, fetchedAt: now() });
      return { status: 'AVAILABLE', source: 'Open-Meteo', cached: false, ...data };
    } catch (error) {
      return {
        status: 'UNAVAILABLE',
        source: 'Open-Meteo',
        error: error.message,
        ...(cached ? {
          staleData: cached.data,
          staleFetchedAt: new Date(cached.fetchedAt).toISOString(),
        } : {}),
      };
    }
  };
}

function assessRisk({ telemetry, inventory, weather, now }) {
  const missing = [];
  if (!['OK', 'BREACH'].includes(telemetry.coldChainStatus)) {
    missing.push('Cold-chain telemetry status is unknown.');
  }
  if (!inventory || inventory.stockQuantity <= 0) {
    missing.push('Legacy inventory data is missing or has no stock.');
  }
  if (inventory && Date.parse(`${inventory.expirationDate}T23:59:59Z`) < now) {
    missing.push('The legacy batch expiry date has passed.');
  }
  if (!weather || weather.status !== 'AVAILABLE') {
    missing.push('Live external weather data is unavailable or stale.');
  }
  const telemetryAge = now - Date.parse(telemetry.lastCheckedAt);
  if (!Number.isFinite(telemetryAge) || telemetryAge < 0 || telemetryAge > telemetryMaxAgeMs) {
    missing.push('The latest sensor reading is stale or has an invalid timestamp.');
  }
  if (missing.length) {
    return {
      level: 'INSUFFICIENT_DATA',
      score: null,
      reasons: missing,
      model: 'Explainable demonstration rules; not a clinical or vaccine-safety determination.',
    };
  }

  const reasons = [];
  if (telemetry.coldChainStatus === 'BREACH') {
    reasons.push('The batch has a recorded cold-chain breach.');
  }
  if (inventory.stockQuantity <= 10) {
    reasons.push('Legacy warehouse stock is at or below the 10-dose demonstration threshold.');
  }
  if (weather.temperatureCelsius >= 35) {
    reasons.push('Open-Meteo reports ambient temperature at or above 35°C along the recorded route.');
  }
  const upperEdge = telemetry.currentTempCelsius >= telemetry.safeMaxCelsius - 1;
  const lowerEdge = telemetry.currentTempCelsius <= telemetry.safeMinCelsius + 1;
  if (upperEdge || lowerEdge) {
    reasons.push('The latest sensor reading is within 1°C of the batch safe-range boundary.');
  }

  const level = telemetry.coldChainStatus === 'BREACH'
    ? 'HIGH'
    : reasons.length > 0 ? 'ELEVATED' : 'LOW';
  if (!reasons.length) {
    reasons.push('The latest sensor reading and retrieved inventory are within the configured demonstration rules.');
  }
  const score = level === 'HIGH' ? 100 : level === 'ELEVATED' ? Math.min(80, 40 + reasons.length * 10) : 10;
  return {
    level,
    score,
    reasons,
    model: 'Explainable demonstration rules; not a clinical or vaccine-safety determination.',
  };
}

export function createMashupServer({
  telemetryUrl,
  legacyAdapterUrl,
  getWeather = createOpenMeteoProvider(),
  now = () => Date.now(),
} = {}) {
  return http.createServer(async (request, response) => {
    const correlationId = String(request.headers['x-correlation-id'] || crypto.randomUUID());
    const pathname = new URL(request.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      return sendJson(response, 200, { status: 'UP', service: 'vaccine-risk-mashup-engine' }, correlationId);
    }
    const match = /^\/risk-assessment\/shipment\/([^/]+)$/.exec(pathname);
    if (request.method !== 'GET' || !match) {
      return errorResponse(response, 404, 'RESOURCE_NOT_FOUND', 'Mashup resource not found.', { path: pathname }, correlationId);
    }
    let shipmentId;
    try {
      shipmentId = decodeURIComponent(match[1]);
    } catch {
      return errorResponse(response, 400, 'INVALID_FORMAT', 'The shipment identifier is malformed.', {}, correlationId);
    }
    try {
      const telemetryResponse = await fetch(`${telemetryUrl}/telemetry`, {
        headers: { Accept: 'application/json', 'X-Correlation-ID': correlationId },
        signal: AbortSignal.timeout(3000),
      });
      if (!telemetryResponse.ok) {
        return errorResponse(response, 503, 'SERVICE_UNAVAILABLE', 'Telemetry service is unavailable to the risk assessment.', {
          targetService: 'Vaccine Cold-Chain Telemetry Service',
        }, correlationId);
      }
      const batches = await telemetryResponse.json();
      const telemetry = batches.find((batch) => batch.shipmentId === shipmentId || batch.vaccineId === shipmentId);
      if (!telemetry) {
        return errorResponse(response, 404, 'RESOURCE_NOT_FOUND', 'No telemetry batch matches this shipment or vaccine id.', {
          shipmentId,
        }, correlationId);
      }

      const [inventoryResult, weatherResult] = await Promise.allSettled([
        fetch(`${legacyAdapterUrl}/stock/sync/${encodeURIComponent(telemetry.vaccineId)}`, {
          headers: { Accept: 'application/json', 'X-Correlation-ID': correlationId },
          signal: AbortSignal.timeout(3500),
        }).then(async (upstream) => {
          if (!upstream.ok) {
            throw new Error(`Legacy inventory adapter returned HTTP ${upstream.status}.`);
          }
          return upstream.json();
        }),
        Number.isFinite(telemetry.latitude) && Number.isFinite(telemetry.longitude)
          ? getWeather({ latitude: telemetry.latitude, longitude: telemetry.longitude })
          : Promise.resolve({ status: 'UNAVAILABLE', source: 'Open-Meteo', error: 'Shipment coordinates are missing.' }),
      ]);

      const inventory = inventoryResult.status === 'fulfilled' ? inventoryResult.value : null;
      const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : {
        status: 'UNAVAILABLE',
        source: 'Open-Meteo',
        error: weatherResult.reason?.message || 'External weather lookup failed.',
      };
      const assessment = assessRisk({ telemetry, inventory, weather, now: now() });
      return sendJson(response, 200, {
        shipmentId: telemetry.shipmentId,
        vaccineId: telemetry.vaccineId,
        assessment,
        sources: {
          telemetry: {
            status: 'AVAILABLE',
            service: 'Vaccine Cold-Chain Telemetry Service',
            lastCheckedAt: telemetry.lastCheckedAt,
            currentTempCelsius: telemetry.currentTempCelsius,
            safeRangeCelsius: telemetry.safeRangeCelsius,
            coldChainStatus: telemetry.coldChainStatus,
          },
          legacyInventory: inventory
            ? { status: 'AVAILABLE', service: 'Legacy HIS REST-to-SOAP Adapter', ...inventory }
            : {
              status: 'UNAVAILABLE',
              service: 'Legacy HIS REST-to-SOAP Adapter',
              error: inventoryResult.reason?.message || 'Inventory response is unavailable.',
            },
          weather,
        },
        generatedAt: new Date(now()).toISOString(),
      }, correlationId);
    } catch {
      return errorResponse(response, 503, 'SERVICE_UNAVAILABLE', 'Telemetry could not be read to build a risk assessment.', {
        targetService: 'Vaccine Cold-Chain Telemetry Service',
      }, correlationId);
    }
  });
}
