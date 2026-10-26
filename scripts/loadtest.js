#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

function parseArguments(args) {
  const options = {
    targetUrl: '',
    durationSeconds: 10,
    concurrencyLevels: [1, 5, 10],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--url' && value) {
      options.targetUrl = value;
      index += 1;
    } else if (argument === '--duration' && value) {
      options.durationSeconds = Number(value);
      index += 1;
    } else if (argument === '--concurrency' && value) {
      options.concurrencyLevels = value.split(',').map(Number);
      index += 1;
    } else {
      throw new TypeError(`Unknown or incomplete option: ${argument}`);
    }
  }

  return options;
}

function validateTarget(targetUrl) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new TypeError('Provide a valid loopback HTTP URL with --url.');
  }
  if (url.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new TypeError('Load testing is restricted to local loopback HTTP targets.');
  }
  return url;
}

export async function runLoadTest({
  targetUrl,
  durationSeconds = 15,
  concurrency = 10,
  fetchImpl = fetch,
} = {}) {
  const url = validateTarget(targetUrl);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 120) {
    throw new RangeError('Duration must be a whole number between 1 and 120 seconds.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new RangeError('Concurrency must be a whole number between 1 and 100.');
  }

  const durations = [];
  let failures = 0;
  const deadline = Date.now() + durationSeconds * 1000;
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      const requestStartedAt = performance.now();
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
        durations.push(performance.now() - requestStartedAt);
        if (!response.ok) failures += 1;
        await response.body?.cancel();
      } catch {
        durations.push(performance.now() - requestStartedAt);
        failures += 1;
      }
    }
  }));

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const sortedDurations = durations.sort((left, right) => left - right);
  const percentile = (percentage) => sortedDurations.length
    ? Number(sortedDurations[Math.ceil(sortedDurations.length * percentage) - 1].toFixed(2))
    : null;
  return {
    target: url.toString(),
    durationSeconds: Number(elapsedSeconds.toFixed(2)),
    concurrency,
    requests: durations.length,
    failures,
    requestsPerSecond: Number((durations.length / elapsedSeconds).toFixed(2)),
    latencyMs: {
      min: sortedDurations.length ? Number(sortedDurations[0].toFixed(2)) : null,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sortedDurations.length ? Number(sortedDurations.at(-1).toFixed(2)) : null,
    },
  };
}

export async function runLoadProfile({
  targetUrl,
  durationSeconds = 10,
  concurrencyLevels = [1, 5, 10],
  fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(concurrencyLevels) || concurrencyLevels.length === 0
    || concurrencyLevels.some((level, index) => !Number.isInteger(level)
      || level < 1 || level > 100
      || (index > 0 && level <= concurrencyLevels[index - 1]))) {
    throw new RangeError('Concurrency levels must be a strictly increasing list of whole numbers from 1 to 100.');
  }
  const stages = [];
  for (const concurrency of concurrencyLevels) {
    stages.push(await runLoadTest({
      targetUrl,
      durationSeconds,
      concurrency,
      fetchImpl,
    }));
  }
  return { target: targetUrl, stageDurationSeconds: durationSeconds, stages };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.targetUrl) {
    throw new TypeError('Usage: node scripts/loadtest.js --url http://127.0.0.1:5002/telemetry/VAX-1001 [--duration 10] [--concurrency 1,5,10]');
  }
  const result = await runLoadProfile(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.stages.some((stage) => stage.requests === 0 || stage.failures > 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
