import crypto from 'node:crypto';
import http from 'node:http';

const maxBodySize = 64 * 1024;
const soapNamespace = 'http://schemas.xmlsoap.org/soap/envelope/';
const wsdl = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:BakunaPassLegacyInventory" xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:BakunaPassLegacyInventory" name="LegacyInventoryService">
  <message name="GetInventoryBatchRequest"><part name="vaccineId" type="xsd:string" /></message>
  <message name="GetInventoryBatchResponse"><part name="inventory" type="xsd:string" /></message>
  <message name="GetWarehouseInventoryRequest"><part name="warehouseCode" type="xsd:string" /></message>
  <message name="GetWarehouseInventoryResponse"><part name="inventory" type="xsd:string" /></message>
  <message name="ReserveStockRequest"><part name="vaccineId" type="xsd:string" /><part name="quantity" type="xsd:int" /></message>
  <message name="ReserveStockResponse"><part name="inventory" type="xsd:string" /></message>
  <portType name="LegacyInventoryPortType">
    <operation name="GetInventoryBatch"><input message="tns:GetInventoryBatchRequest" /><output message="tns:GetInventoryBatchResponse" /></operation>
    <operation name="GetWarehouseInventory"><input message="tns:GetWarehouseInventoryRequest" /><output message="tns:GetWarehouseInventoryResponse" /></operation>
    <operation name="ReserveStock"><input message="tns:ReserveStockRequest" /><output message="tns:ReserveStockResponse" /></operation>
  </portType>
  <binding name="LegacyInventorySoapBinding" type="tns:LegacyInventoryPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http" />
    <operation name="GetInventoryBatch"><soap:operation soapAction="urn:BakunaPassLegacyInventory/GetInventoryBatch" /></operation>
    <operation name="GetWarehouseInventory"><soap:operation soapAction="urn:BakunaPassLegacyInventory/GetWarehouseInventory" /></operation>
    <operation name="ReserveStock"><soap:operation soapAction="urn:BakunaPassLegacyInventory/ReserveStock" /></operation>
  </binding>
  <service name="LegacyInventoryService"><port name="LegacyInventorySoapPort" binding="tns:LegacyInventorySoapBinding"><soap:address location="/soap" /></port></service>
</definitions>`;

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
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, name) => ({
    lt: '<',
    gt: '>',
    amp: '&',
    quot: '"',
    apos: "'",
  })[name]);
}

function xmlValue(xml, name) {
  const match = new RegExp(`<(?:(?:[A-Za-z][\\w.-]*):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z][\\w.-]*):)?${name}\\s*>`, 'i').exec(xml);
  return match ? unescapeXml(match[1].trim()) : undefined;
}

function inventoryToXml(item) {
  return `  <InventoryBatch>
    <VaccineId>${escapeXml(item.vaccineId)}</VaccineId>
    <VaccineName>${escapeXml(item.vaccineName)}</VaccineName>
    <WarehouseCode>${escapeXml(item.warehouseCode)}</WarehouseCode>
    <StockQuantity>${escapeXml(item.stockQuantity)}</StockQuantity>
    <ExpirationDate>${escapeXml(item.expirationDate)}</ExpirationDate>
    <SafeMinCelsius>${escapeXml(item.safeMinCelsius)}</SafeMinCelsius>
    <SafeMaxCelsius>${escapeXml(item.safeMaxCelsius)}</SafeMaxCelsius>
  </InventoryBatch>`;
}

function soapEnvelope(operation, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${soapNamespace}">
  <soap:Body><${operation}Response xmlns="urn:BakunaPassLegacyInventory">${body}</${operation}Response></soap:Body>
</soap:Envelope>`;
}

function soapFault(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${soapNamespace}"><soap:Body><soap:Fault>
  <faultcode>${escapeXml(code)}</faultcode>
  <faultstring>${escapeXml(message)}</faultstring>
</soap:Fault></soap:Body></soap:Envelope>`;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodySize) {
      const error = new Error('SOAP request exceeds the 64 KB limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendXml(response, status, body, correlationId) {
  response.writeHead(status, {
    'Content-Type': 'text/xml; charset=utf-8',
    'X-Correlation-ID': correlationId,
  });
  response.end(body);
}

export function createLegacySoapServer({ store }) {
  return http.createServer(async (request, response) => {
    const correlationId = String(request.headers['x-correlation-id'] || crypto.randomUUID());
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Correlation-ID': correlationId });
      return response.end(JSON.stringify({ status: 'UP', service: 'simulated-legacy-soap-his' }));
    }
    if (request.method === 'GET' && pathname === '/wsdl') {
      response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', 'X-Correlation-ID': correlationId });
      return response.end(wsdl);
    }
    if (request.method !== 'POST' || pathname !== '/soap') {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'X-Correlation-ID': correlationId });
      return response.end(JSON.stringify({ error: 'RESOURCE_NOT_FOUND', message: 'Legacy SOAP resource not found.' }));
    }

    try {
      const contentType = String(request.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('text/xml') && !contentType.includes('application/soap+xml')) {
        return sendXml(response, 415, soapFault('Client', 'Content-Type must be text/xml or application/soap+xml.'), correlationId);
      }
      const xml = await readBody(request);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:(?:[\w.-]+):)?Envelope\b/i.test(xml) || !/<(?:(?:[\w.-]+):)?Body\b/i.test(xml)) {
        return sendXml(response, 400, soapFault('Client', 'Malformed or unsafe SOAP envelope.'), correlationId);
      }
      const actionHeader = String(request.headers.soapaction || '').replace(/^["']|["']$/g, '');
      const actionOperation = actionHeader.split('/').pop();
      const body = /<(?:(?:[\w.-]+):)?Body\b[^>]*>([\s\S]*?)<\/(?:(?:[\w.-]+):)?Body\s*>/i.exec(xml)?.[1] || '';
      const operation = /<(?:(?:[\w.-]+):)?(GetInventoryBatch|GetWarehouseInventory|ReserveStock)\b/i.exec(body)?.[1];
      if (!operation || (actionOperation && actionOperation !== operation)) {
        return sendXml(response, 400, soapFault('Client', 'SOAP operation is missing or does not match SOAPAction.'), correlationId);
      }

      if (operation === 'GetInventoryBatch') {
        const vaccineId = xmlValue(body, 'VaccineId');
        const item = vaccineId && store.findLegacyInventory(vaccineId);
        if (!item) {
          return sendXml(response, 500, soapFault('Inventory.NotFound', `Inventory batch ${vaccineId || '(missing)'} was not found.`), correlationId);
        }
        return sendXml(response, 200, soapEnvelope(operation, inventoryToXml(item)), correlationId);
      }

      if (operation === 'GetWarehouseInventory') {
        const warehouseCode = xmlValue(body, 'WarehouseCode');
        if (!warehouseCode) {
          return sendXml(response, 500, soapFault('Client', 'WarehouseCode is required.'), correlationId);
        }
        const inventory = store.listLegacyInventory(warehouseCode)
          .map(inventoryToXml)
          .join('\n');
        return sendXml(response, 200, soapEnvelope(operation, inventory || '    <Inventory />'), correlationId);
      }

      const vaccineId = xmlValue(body, 'VaccineId');
      const quantity = Number(xmlValue(body, 'Quantity'));
      if (!vaccineId || !Number.isSafeInteger(quantity) || quantity < 1) {
        return sendXml(response, 500, soapFault('Client', 'VaccineId and a positive integer Quantity are required.'), correlationId);
      }
      const item = store.reserveLegacyInventory(vaccineId, quantity);
      if (!item) {
        const exists = store.findLegacyInventory(vaccineId);
        const code = exists ? 'Inventory.InsufficientStock' : 'Inventory.NotFound';
        return sendXml(response, 500, soapFault(code, exists
          ? `Insufficient stock for ${vaccineId}.`
          : `Inventory batch ${vaccineId} was not found.`), correlationId);
      }
      return sendXml(response, 200, soapEnvelope(operation, inventoryToXml(item)), correlationId);
    } catch (error) {
      return sendXml(response, error.statusCode || 500, soapFault('Server', error.message), correlationId);
    }
  });
}

function soapRequest(operation, fields) {
  const body = Object.entries(fields)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${soapNamespace}" xmlns:inv="urn:BakunaPassLegacyInventory">
  <soap:Body><inv:${operation}>${body}</inv:${operation}></soap:Body>
</soap:Envelope>`;
}

function parseInventory(xml) {
  const match = /<(?:(?:[\w.-]+):)?InventoryBatch\b[^>]*>([\s\S]*?)<\/(?:(?:[\w.-]+):)?InventoryBatch\s*>/i.exec(xml);
  if (!match) {
    return null;
  }
  const fields = {
    vaccineId: xmlValue(match[0], 'VaccineId'),
    vaccineName: xmlValue(match[0], 'VaccineName'),
    warehouseCode: xmlValue(match[0], 'WarehouseCode'),
    stockQuantity: Number(xmlValue(match[0], 'StockQuantity')),
    expirationDate: xmlValue(match[0], 'ExpirationDate'),
    safeMinCelsius: Number(xmlValue(match[0], 'SafeMinCelsius')),
    safeMaxCelsius: Number(xmlValue(match[0], 'SafeMaxCelsius')),
  };
  return Object.values(fields).some((value) => value === undefined || (typeof value === 'number' && !Number.isFinite(value)))
    ? null
    : fields;
}

export function createLegacyAdapterServer({ soapUrl }) {
  return http.createServer(async (request, response) => {
    const correlationId = String(request.headers['x-correlation-id'] || crypto.randomUUID());
    const pathname = new URL(request.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const sendJson = (status, body) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Correlation-ID': correlationId,
      });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/stock/health')) {
      return sendJson(200, { status: 'UP', service: 'legacy-his-rest-soap-adapter' });
    }
    if (request.method === 'GET' && (pathname === '/wsdl' || pathname === '/stock/wsdl')) {
      try {
        const upstream = await fetch(`${soapUrl}/wsdl`, { signal: AbortSignal.timeout(3000) });
        if (!upstream.ok) {
          return sendJson(502, {
            error: 'UPSTREAM_ERROR',
            message: 'The legacy SOAP HIS could not provide its WSDL.',
            details: { targetService: 'Simulated Legacy SOAP HIS' },
            timestamp: new Date().toISOString(),
            correlationId,
          });
        }
        response.writeHead(200, {
          'Content-Type': 'text/xml; charset=utf-8',
          'X-Correlation-ID': correlationId,
        });
        return response.end(await upstream.text());
      } catch {
        return sendJson(503, {
          error: 'SERVICE_UNAVAILABLE',
          message: 'The legacy SOAP HIS could not be reached for its WSDL.',
          details: { targetService: 'Simulated Legacy SOAP HIS' },
          timestamp: new Date().toISOString(),
          correlationId,
        });
      }
    }

    const warehouseMatch = /^\/stock\/warehouse\/([^/]+)$/.exec(pathname);
    const batchMatch = /^\/stock\/sync\/([^/]+)$/.exec(pathname);
    const reserveRoute = request.method === 'POST' && pathname === '/stock/reserve';
    if (!warehouseMatch && !batchMatch && !reserveRoute) {
      return sendJson(404, {
        error: 'RESOURCE_NOT_FOUND',
        message: 'The requested legacy inventory adapter resource does not exist.',
        details: { path: pathname },
        timestamp: new Date().toISOString(),
        correlationId,
      });
    }

    try {
      let operation;
      let fields;
      if (warehouseMatch) {
        operation = 'GetWarehouseInventory';
        fields = { WarehouseCode: decodeURIComponent(warehouseMatch[1]) };
      } else if (batchMatch) {
        operation = 'GetInventoryBatch';
        fields = { VaccineId: decodeURIComponent(batchMatch[1]) };
      } else {
        let raw = '';
        for await (const chunk of request) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 16 * 1024) {
            return sendJson(413, { error: 'PAYLOAD_TOO_LARGE', message: 'Reservation request exceeds 16 KB.', correlationId });
          }
        }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(400, { error: 'MALFORMED_PAYLOAD', message: 'Reservation request must be valid JSON.', correlationId });
        }
        const vaccineId = String(payload?.vaccineId || '').trim();
        const quantity = Number(payload?.quantity);
        if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/i.test(vaccineId)
          || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
          return sendJson(400, {
            error: 'INVALID_FORMAT',
            message: 'A valid vaccineId and positive integer quantity are required.',
            details: { fields: ['vaccineId', 'quantity'] },
            correlationId,
          });
        }
        operation = 'ReserveStock';
        fields = { VaccineId: vaccineId, Quantity: quantity };
      }

      const upstream = await fetch(`${soapUrl}/soap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `urn:BakunaPassLegacyInventory/${operation}`,
          'X-Correlation-ID': correlationId,
        },
        body: soapRequest(operation, fields),
        signal: AbortSignal.timeout(3000),
      });
      const xml = await upstream.text();
      if (!upstream.ok || /<(?:\w+:)?Fault\b/i.test(xml)) {
        const faultCode = xmlValue(xml, 'faultcode') || 'LegacyHIS.Fault';
        const faultMessage = xmlValue(xml, 'faultstring') || 'The legacy SOAP HIS rejected the request.';
        const status = faultCode.includes('NotFound') ? 404
          : faultCode.includes('InsufficientStock') ? 409 : 502;
        return sendJson(status, {
          error: status === 404 ? 'RESOURCE_NOT_FOUND'
            : status === 409 ? 'INSUFFICIENT_STOCK' : 'UPSTREAM_ERROR',
          message: faultMessage,
          details: { targetService: 'Simulated Legacy SOAP HIS', faultCode },
          timestamp: new Date().toISOString(),
          correlationId,
        });
      }

      const inventory = parseInventory(xml);
      if (operation === 'GetWarehouseInventory') {
        const items = [...xml.matchAll(/<(?:(?:[\w.-]+):)?InventoryBatch\b[^>]*>[\s\S]*?<\/(?:(?:[\w.-]+):)?InventoryBatch\s*>/gi)]
          .map((match) => parseInventory(match[0]))
          .filter(Boolean);
        return sendJson(200, { warehouseCode: fields.WarehouseCode, items, syncedAt: new Date().toISOString() });
      }
      if (!inventory) {
        return sendJson(502, {
          error: 'UPSTREAM_ERROR',
          message: 'The legacy HIS returned an invalid inventory response.',
          details: { targetService: 'Simulated Legacy SOAP HIS' },
          timestamp: new Date().toISOString(),
          correlationId,
        });
      }
      return sendJson(200, { ...inventory, syncedAt: new Date().toISOString() });
    } catch {
      return sendJson(503, {
        error: 'SERVICE_UNAVAILABLE',
        message: 'The legacy SOAP HIS could not be reached; no stock was reserved.',
        details: { targetService: 'Simulated Legacy SOAP HIS' },
        timestamp: new Date().toISOString(),
        correlationId,
      });
    }
  });
}
