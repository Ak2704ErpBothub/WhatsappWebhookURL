require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const logger = require('./logger');

/*
 * EBH WhatsApp webhook receiver (Meta Cloud API + Meta-compatible providers).
 *
 *   GET  /            Meta verification handshake (hub.challenge)
 *   POST /            Meta delivers messages / statuses here (signature checked)
 *   GET  /events      EBH Orchestrator pulls pending events   (Bearer API_KEY)
 *   POST /events/ack  EBH Orchestrator confirms what it stored (Bearer API_KEY)
 *   GET  /health      liveness probe
 *
 * The desktop app is not publicly reachable, so it PULLS from here. Events are
 * kept in a small JSON-lines file until acknowledged, so a Render/AWS restart
 * or a desktop that is offline for a while loses nothing (use a persistent disk).
 *
 * Environment:
 *   VERIFY_TOKEN  the string you type into Meta "Verify token"       (required)
 *   API_KEY       shared secret the desktop app uses to pull events  (required)
 *   APP_SECRET    Meta app secret; enables X-Hub-Signature-256 check (recommended)
 *   DATA_DIR      where the queue file lives (default ./data)
 *   MAX_EVENTS    queue cap (default 20000)
 */

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const apiKey = process.env.API_KEY;
const appSecret = process.env.APP_SECRET;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const maxEvents = parseInt(process.env.MAX_EVENTS || '20000', 10);

if (!verifyToken || !apiKey) {
  logger.error('VERIFY_TOKEN and API_KEY must be set');
  process.exit(1);
}
if (!appSecret) logger.warn('APP_SECRET not set - webhook signatures are NOT being verified');

fs.mkdirSync(dataDir, { recursive: true });
const queueFile = path.join(dataDir, 'events.jsonl');

/** @type {Array<object>} */
let queue = [];
if (fs.existsSync(queueFile)) {
  for (const line of fs.readFileSync(queueFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { queue.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  logger.info(`Loaded ${queue.length} pending event(s)`);
}

function persist() {
  fs.writeFileSync(queueFile, queue.map(e => JSON.stringify(e)).join('\n') + (queue.length ? '\n' : ''));
}

/** Flatten a Meta webhook payload into one simple record per message/status. */
function normalize(body) {
  const out = [];
  const receivedAt = new Date().toISOString();
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = v.metadata && v.metadata.phone_number_id;
      const displayPhone = v.metadata && v.metadata.display_phone_number;

      for (const m of v.messages || []) {
        const contact = (v.contacts || []).find(c => c.wa_id === m.from);
        out.push({
          id: `msg:${m.id}`,
          kind: 'message',
          receivedAt,
          wabaId: entry.id,
          phoneNumberId, displayPhone,
          messageId: m.id,
          from: m.from,
          contactName: contact && contact.profile && contact.profile.name,
          type: m.type,
          text: m.text ? m.text.body
            : m.button ? m.button.text
            : m.interactive ? JSON.stringify(m.interactive)
            : m.caption || '',
          mediaId: (m[m.type] && m[m.type].id) || null,
          timestamp: m.timestamp,
          raw: m
        });
      }

      for (const s of v.statuses || []) {
        out.push({
          id: `st:${s.id}:${s.status}:${s.timestamp}`,
          kind: 'status',
          receivedAt,
          wabaId: entry.id,
          phoneNumberId, displayPhone,
          messageId: s.id,
          from: s.recipient_id,
          status: s.status,                // sent | delivered | read | failed
          errors: s.errors || null,
          timestamp: s.timestamp,
          raw: s
        });
      }

      // Template status changes etc. are kept raw so nothing is dropped.
      if (change.field && change.field !== 'messages') {
        out.push({
          id: `fld:${entry.id}:${change.field}:${Date.now()}`,
          kind: 'other', field: change.field, receivedAt, wabaId: entry.id, raw: v
        });
      }
    }
  }
  return out;
}

function validSignature(req) {
  if (!appSecret) return true;
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(apiKey);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

const app = express();
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }   // exact bytes for the HMAC
}));

app.get('/health', (_req, res) => res.json({ ok: true, pending: queue.length }));

app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('Webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('Webhook verification failed', { mode });
  res.status(403).end();
});

app.post('/', (req, res) => {
  if (!validSignature(req)) {
    logger.warn('Rejected webhook: bad signature');
    return res.status(401).end();
  }
  const events = normalize(req.body || {});
  const known = new Set(queue.map(e => e.id));
  let added = 0;
  for (const e of events) {
    if (known.has(e.id)) continue;       // Meta retries: de-duplicate
    queue.push(e); added++;
  }
  if (queue.length > maxEvents) queue = queue.slice(queue.length - maxEvents);
  if (added) persist();
  logger.info(`Webhook received: ${events.length} event(s), ${added} new`);
  res.status(200).end();                 // always answer fast, Meta retries on non-200
});

app.get('/events', requireApiKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  res.json({ pending: queue.length, events: queue.slice(0, limit) });
});

app.post('/events/ack', requireApiKey, (req, res) => {
  const ids = new Set(Array.isArray(req.body && req.body.ids) ? req.body.ids : []);
  const before = queue.length;
  queue = queue.filter(e => !ids.has(e.id));
  if (queue.length !== before) persist();
  res.json({ removed: before - queue.length, pending: queue.length });
});

app.listen(port, () => logger.info(`Server listening on port ${port}`));
