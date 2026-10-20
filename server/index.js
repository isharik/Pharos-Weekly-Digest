import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { NETWORKS, createDigestReport, followingRun, nextRunAfter, renderDigestText } from './digest.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataPath = process.env.DIGEST_DATA_FILE || join(here, '..', '.data', 'scheduler.json');
const apiToken = process.env.DIGEST_API_TOKEN || '';
const port = Number(process.env.PORT || 8787);
const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', process.env.WEB_ORIGIN].filter(Boolean));
const smtpConfig = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER
};
const configuredSocialScanKey = process.env.SOCIALSCAN_API_KEY || '';
const socialScanApiKey = configuredSocialScanKey.startsWith('replace-with-') ? '' : configuredSocialScanKey;

if (apiToken.length < 32 || apiToken.startsWith('replace-with-')) {
  throw new Error('Set DIGEST_API_TOKEN to a random secret with at least 32 characters.');
}

function hasSmtpConfig() {
  const values = [smtpConfig.host, smtpConfig.user, smtpConfig.pass, smtpConfig.from];
  return values.every((value) => value && !/(example\.com|replace-with|your-smtp)/i.test(value));
}

function createTransport() {
  if (!hasSmtpConfig()) throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000
  });
}

function initialState() {
  return {
    schedule: {
      enabled: false,
      network: 'atlantic',
      address: '',
      label: '',
      recipient: '',
      frequency: 'weekly',
      day: 'Monday',
      time: '09:00',
      nextRunAt: null,
      updatedAt: null
    },
    history: []
  };
}

let state = initialState();
let runInProgress = false;
let persistenceQueue = Promise.resolve();

async function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(dataPath), { recursive: true });
    const temporaryPath = `${dataPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, snapshot, { mode: 0o600 });
    await rename(temporaryPath, dataPath);
  });
  return persistenceQueue;
}

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(dataPath, 'utf8'));
    state = { ...initialState(), ...saved, schedule: { ...initialState().schedule, ...saved.schedule } };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read scheduler state: ${error.message}`);
    state = initialState();
    await persist();
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response, status, value, origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
  if (origin && allowedOrigins.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('Request body exceeds 16 KB.');
  }
  return body ? JSON.parse(body) : {};
}

function validateSchedule(input) {
  const schedule = {
    enabled: input.enabled === true,
    network: input.network,
    address: String(input.address || '').trim(),
    label: String(input.label || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 80),
    recipient: String(input.recipient || '').trim(),
    frequency: input.frequency,
    day: input.day,
    time: input.time
  };
  if (!NETWORKS[schedule.network]) throw new Error('Choose a supported Pharos network.');
  if (!/^0x[a-fA-F0-9]{40}$/.test(schedule.address)) throw new Error('Enter a valid EVM address.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(schedule.recipient)) throw new Error('Enter a valid digest recipient email.');
  if (!['daily', 'weekly', 'biweekly'].includes(schedule.frequency)) throw new Error('Choose a supported cadence.');
  if (!['Sunday', 'Monday', 'Friday'].includes(schedule.day)) throw new Error('Choose a supported delivery day.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('Choose a valid UTC time.');
  if (schedule.enabled && !hasSmtpConfig()) throw new Error('Configure SMTP before enabling the scheduler.');
  if (schedule.enabled && !socialScanApiKey) throw new Error('Set SOCIALSCAN_API_KEY to enable complete period-history reports.');
  return schedule;
}

function summaryEmail(report) {
  const text = renderDigestText(report);
  const safe = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const events = report.notableEvents.length
    ? `<ol>${report.notableEvents.map((event) => `<li>${safe(event.method)} · ${safe(event.value)} ${safe(report.symbol)} · block ${safe(event.blockNumber)} · <a href="${safe(event.explorerUrl)}">View transaction</a></li>`).join('')}</ol>`
    : '<p>No transactions in the current period.</p>';
  const rows = [
    ['Transactions', 'transactionCount', report.comparison.current.transactionCount, report.comparison.previous.transactionCount],
    ['Native volume', 'volume', `${report.comparison.current.volume} ${report.symbol}`, `${report.comparison.previous.volume} ${report.symbol}`],
    ['Counterparties', 'counterparties', report.comparison.current.counterparties, report.comparison.previous.counterparties],
    ['Fees', 'fees', report.comparison.current.fees === null ? 'Unavailable' : `${report.comparison.current.fees} ${report.symbol}`, report.comparison.previous.fees === null ? 'Unavailable' : `${report.comparison.previous.fees} ${report.symbol}`]
  ].map(([label, key, current, previous]) => {
    const delta = report.comparison.deltaPercent[key];
    const change = delta === null
      ? (key !== 'fees' || (report.comparison.current.fees !== null && report.comparison.previous.fees !== null) ? 'New activity' : 'Unavailable')
      : `${delta}%`;
    return `<tr><td style="border-top:1px solid #ddd;padding:8px">${safe(label)}</td><td align="right" style="border-top:1px solid #ddd;padding:8px">${safe(current)}</td><td align="right" style="border-top:1px solid #ddd;padding:8px">${safe(previous)}</td><td align="right" style="border-top:1px solid #ddd;padding:8px">${safe(change)}</td></tr>`;
  }).join('');
  return {
    text,
    html: `
      <main style="font:15px/1.5 Arial,sans-serif;max-width:760px;margin:auto;color:#172033">
        <h1>${safe(report.label)} · Pharos Digest</h1>
        <p>${safe(report.networkName)} · ${safe(report.address)}</p>
        <p>
          <b>Current period:</b> ${safe(report.window.currentFrom)} — ${safe(report.window.currentTo)}<br>
          <b>Previous period:</b> ${safe(report.window.previousFrom)} — ${safe(report.window.previousTo)}
        </p>
        <table style="border-collapse:collapse;width:100%">
          <thead><tr><th align="left">Metric</th><th align="right">Current</th><th align="right">Previous</th><th align="right">Change</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <h2>Notable current-period events</h2>${events}
        <p style="color:#667085;font-size:12px">Coverage: ${safe(report.coverage.explorerPages)} SocialScan page(s), blocks ${safe(report.coverage.blockRange.from)}–${safe(report.coverage.blockRange.to)}. Generated ${safe(report.generatedAt)}.</p>
      </main>`
  };
}

async function executeDigest(schedule, trigger, scheduledFor = null) {
  if (runInProgress) throw new Error('A digest run is already in progress.');
  if (!hasSmtpConfig()) throw new Error('SMTP is not configured on the server.');
  runInProgress = true;
  const startedAt = new Date().toISOString();
  let report;
  try {
    report = await createDigestReport(schedule);
    const message = summaryEmail(report);
    const sent = await createTransport().sendMail({
      from: smtpConfig.from,
      to: schedule.recipient,
      subject: `[Pharos Digest] ${report.label} · ${report.networkName}`,
      text: message.text,
      html: message.html
    });
    if (!sent.accepted?.some((address) => address.toLowerCase() === schedule.recipient.toLowerCase())) {
      throw new Error(`SMTP did not accept recipient ${schedule.recipient}.`);
    }
    const record = {
      id: randomUUID(), trigger, scheduledFor, status: 'accepted', startedAt, finishedAt: new Date().toISOString(),
      recipient: schedule.recipient, messageId: sent.messageId, smtpResponse: sent.response,
      report
    };
    state.history.unshift(record);
    state.history = state.history.slice(0, 100);
    await persist();
    return record;
  } catch (error) {
    const record = {
      id: randomUUID(), trigger, scheduledFor, status: 'failed', startedAt, finishedAt: new Date().toISOString(),
      recipient: schedule.recipient, error: error.message, report: report || null
    };
    state.history.unshift(record);
    state.history = state.history.slice(0, 100);
    await persist();
    throw Object.assign(error, { runId: record.id });
  } finally {
    runInProgress = false;
  }
}

function publicStatus() {
  return {
    schedule: state.schedule,
    configured: Boolean(state.schedule.address && state.schedule.recipient),
    emailConfigured: hasSmtpConfig(),
    historyConfigured: Boolean(socialScanApiKey),
    lastRun: state.history[0] || null,
    recentRuns: state.history.slice(0, 10).map(({ report: _report, ...run }) => run)
  };
}

const api = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: 'Origin is not allowed.' });
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600', vary: 'Origin'
    });
    return response.end();
  }
  if (!request.url?.startsWith('/api/')) return sendJson(response, 404, { error: 'Not found.' }, origin);
  const suppliedToken = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(suppliedToken, apiToken)) return sendJson(response, 401, { error: 'Invalid scheduler API token.' }, origin);

  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/api/status') return sendJson(response, 200, publicStatus(), origin);
    if (request.method === 'PUT' && path === '/api/schedule') {
      const input = await readBody(request);
      const schedule = validateSchedule(input);
      const nextRunAt = schedule.enabled ? nextRunAfter(schedule).toISOString() : null;
      state.schedule = { ...schedule, nextRunAt, updatedAt: new Date().toISOString() };
      await persist();
      return sendJson(response, 200, publicStatus(), origin);
    }
    if (request.method === 'POST' && path === '/api/run') {
      if (!state.schedule.address) return sendJson(response, 409, { error: 'Save a schedule configuration before running a digest.' }, origin);
      const record = await executeDigest(state.schedule, 'manual');
      return sendJson(response, 200, record, origin);
    }
    if (request.method === 'GET' && path === '/api/history') return sendJson(response, 200, state.history, origin);
    if (request.method === 'GET' && path === '/api/health') return sendJson(response, 200, { ok: true, emailConfigured: hasSmtpConfig(), historyConfigured: Boolean(socialScanApiKey) }, origin);
    return sendJson(response, 404, { error: 'Not found.' }, origin);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : /already in progress/.test(error.message) ? 409 : 422;
    return sendJson(response, status, { error: error.message, runId: error.runId }, origin);
  }
});

async function tickScheduler() {
  if (runInProgress) return;
  const schedule = state.schedule;
  if (!schedule.enabled || !schedule.nextRunAt || Date.now() < Date.parse(schedule.nextRunAt)) return;
  const dueAt = schedule.nextRunAt;
  const now = Date.now();
  let nextRunAt = followingRun(schedule, dueAt);
  while (nextRunAt.getTime() <= now) nextRunAt = followingRun(schedule, nextRunAt);
  schedule.nextRunAt = nextRunAt.toISOString();
  await persist();
  try {
    await executeDigest(schedule, 'scheduled', dueAt);
  } catch (error) {
    console.error(`Scheduled digest failed (${dueAt}): ${error.message}`);
  }
}

await loadState();
api.listen(port, '0.0.0.0', () => {
  console.log(`Pharos digest API and scheduler listening on port ${port}`);
  if (!hasSmtpConfig()) console.warn('SMTP is not configured; scheduling and email delivery are unavailable.');
});
const schedulerTimer = setInterval(() => tickScheduler().catch((error) => console.error(error)), 10_000);
const shutdown = () => {
  clearInterval(schedulerTimer);
  api.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
