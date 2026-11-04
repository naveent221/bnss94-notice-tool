/*
 * BNSS94 mail helper — local HTTP API used by index.html.
 *
 * Runs on the officer's own computer, listens on 127.0.0.1 only, and talks to
 * the officer's own mail server: SMTP to send notices, IMAP to pick up
 * replies. Every request (except /ping) must carry the pairing code shown in
 * the helper's window, so other web pages cannot use it.
 *
 * Data directory:
 *   config.json   server settings and pairing code (password only if "remember" was chosen)
 *   state.json    IMAP position, watch list, last check / error
 *   inbox/*.eml   replies waiting to be collected by the app
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const smtp = require('./smtp');
const imap = require('./imap');
const M = require('../js/mail.js');

const VERSION = 1;
const MAX_BODY = 60 * 1024 * 1024;

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += A[bytes[i] % A.length] + (i % 4 === 3 && i < 11 ? '-' : '');
  return s;
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function sameCode(a, b) {
  a = Buffer.from(String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '')); b = Buffer.from(String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/**
 * @param opts { dataDir, port, host, newCode, log, pollEveryMs }
 */
function createHelper(opts) {
  const dataDir = opts.dataDir;
  const inboxDir = path.join(dataDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const cfgFile = path.join(dataDir, 'config.json'), stateFile = path.join(dataDir, 'state.json');
  const log = opts.log || ((m) => console.log(new Date().toLocaleTimeString() + '  ' + m));

  let config = readJson(cfgFile, {});
  if (!config.code || opts.newCode) { config.code = newCode(); writeJson(cfgFile, config); }
  let password = config.rememberPassword ? config.pass || '' : '';
  let state = readJson(stateFile, { watch: { refs: [], emails: [], messageIds: [], since: null } });
  const saveConfig = () => {
    const out = Object.assign({}, config);
    if (config.rememberPassword) out.pass = password; else delete out.pass;
    writeJson(cfgFile, out);
  };
  const saveState = () => writeJson(stateFile, state);

  const configured = () => !!(config.smtp && config.smtp.host && config.imap && config.imap.host && config.user && config.fromEmail);
  const smtpCfg = () => Object.assign({}, config.smtp, { user: config.user, pass: password });
  const imapCfg = () => Object.assign({}, config.imap, { user: config.user, pass: password });

  function status() {
    return {
      app: 'bnss94-mail-helper', version: VERSION, configured: configured(), hasPassword: !!password,
      fromEmail: config.fromEmail || '', fromName: config.fromName || '', user: config.user || '',
      smtp: config.smtp || null, imap: config.imap || null,
      pollMinutes: config.pollMinutes || 5, saveToSent: config.saveToSent !== false, rememberPassword: !!config.rememberPassword,
      lastCheck: state.lastCheck || null, lastError: state.lastError || null,
      watching: (state.watch.refs || []).length, queued: fs.readdirSync(inboxDir).filter((f) => f.endsWith('.eml')).length
    };
  }

  // ------------------------------------------------------------ reply polling
  let checking = null;
  function headerMatches(headerBuf) {
    const w = state.watch;
    const mail = M.parseEml(headerBuf);
    const text = mail.subject + ' ' + (mail.headers['in-reply-to'] || '') + ' ' + (mail.headers.references || '');
    const refs = (mail.subject.match(M.REF_RE) || []).map((r) => r.toUpperCase());
    if (refs.some((r) => (w.refs || []).indexOf(r) >= 0)) return true;
    if ((w.messageIds || []).some((id) => text.indexOf(id) >= 0)) return true;
    const from = mail.fromEmail, dom = from.split('@')[1];
    if ((w.emails || []).indexOf(from) >= 0) return true;
    return !!dom && (w.emails || []).some((e) => e.split('@')[1] === dom);
  }

  function check(reason) {
    if (checking) return checking;
    if (!configured() || !password) return Promise.resolve({ skipped: 'not configured' });
    if (!(state.watch.refs || []).length) return Promise.resolve({ skipped: 'no notices to watch' });
    const since = state.watch.since ? new Date(Date.parse(state.watch.since) - 864e5) : null;
    checking = imap.fetchNew(imapCfg(), { since, lastUid: state.lastUid, uidValidity: state.uidValidity, filter: headerMatches })
      .then((r) => {
        r.messages.forEach((m) => {
          const id = 'r' + r.uidValidity + '-' + m.uid;
          fs.writeFileSync(path.join(inboxDir, id + '.eml'), m.raw, { mode: 0o600 });
        });
        state.uidValidity = r.uidValidity; state.lastUid = r.lastUid;
        state.lastCheck = new Date().toISOString(); state.lastError = null;
        saveState();
        if (r.messages.length) log('Mailbox check (' + reason + '): ' + r.messages.length + ' reply(ies) found');
        return { scanned: r.scanned, found: r.messages.length };
      })
      .catch((e) => {
        state.lastCheck = new Date().toISOString(); state.lastError = e.message; saveState();
        log('Mailbox check failed: ' + e.message);
        throw e;
      })
      .finally(() => { checking = null; });
    return checking;
  }

  const timer = setInterval(() => {
    const every = (config.pollMinutes || 5) * 60000;
    if (!state.lastCheck || Date.now() - Date.parse(state.lastCheck) >= every) check('scheduled').catch(() => {});
  }, opts.pollEveryMs || 30000);
  timer.unref();

  // ---------------------------------------------------------------- actions
  async function send(body) {
    if (!configured() || !password) throw httpError(409, 'Mail account is not set up in the helper yet');
    const to = (body.to || []).filter(Boolean);
    if (!to.length) throw httpError(400, 'No recipients');
    const domain = (config.fromEmail.split('@')[1] || 'bnss94.local');
    const messageId = String(body.ref || 'notice').toLowerCase().replace(/[^a-z0-9.-]/g, '') + '.' + crypto.randomBytes(6).toString('hex') + '@' + domain;
    const raw = M.buildEml({
      fromName: config.fromName, fromEmail: config.fromEmail, to, cc: body.cc || [], subject: body.subject, text: body.text,
      attachments: (body.attachments || []).map((a) => ({ name: a.name, type: a.type, data: Buffer.from(a.base64 || '', 'base64') })),
      messageId, unsent: false
    });
    const result = await smtp.sendMail(smtpCfg(), { from: config.fromEmail, to: to.concat(body.cc || []) }, raw);
    log('Sent ' + (body.ref || 'message') + ' to ' + result.accepted.length + ' recipient(s)' + (result.rejected.length ? ', ' + result.rejected.length + ' rejected' : ''));
    let savedToSent = null, warning = null;
    if (config.saveToSent !== false) {
      try { savedToSent = (await imap.appendSent(imapCfg(), raw)).folder; } catch (e) { warning = 'Sent, but could not save a copy in the Sent folder: ' + e.message; }
    }
    return { ok: true, messageId: '<' + messageId + '>', accepted: result.accepted, rejected: result.rejected, sentAt: new Date().toISOString(), savedToSent, warning };
  }

  async function setConfig(b) {
    const pick = (x) => x && { host: String(x.host || '').trim(), port: +x.port || undefined, secure: !!x.secure, rejectUnauthorized: x.rejectUnauthorized !== false, allowPlain: !!x.allowPlain, sentFolder: x.sentFolder || undefined };
    if (b.smtp) config.smtp = pick(b.smtp);
    if (b.imap) config.imap = pick(b.imap);
    ['user', 'fromEmail', 'fromName'].forEach((k) => { if (b[k] != null) config[k] = String(b[k]).trim(); });
    if (b.pollMinutes != null) config.pollMinutes = Math.min(120, Math.max(1, +b.pollMinutes || 5));
    if (b.saveToSent != null) config.saveToSent = !!b.saveToSent;
    if (b.rememberPassword != null) config.rememberPassword = !!b.rememberPassword;
    if (b.pass) password = String(b.pass);
    if (b.clearPassword) password = '';
    saveConfig();
    log('Mail settings updated for ' + (config.fromEmail || '(no address)'));
    return status();
  }

  async function test() {
    const out = {};
    for (const [name, fn, cfg] of [['smtp', smtp.verify, smtpCfg], ['imap', imap.verify, imapCfg]]) {
      try { await fn(cfg()); out[name] = { ok: true }; } catch (e) { out[name] = { ok: false, error: e.message }; }
    }
    return out;
  }

  function replies() {
    return fs.readdirSync(inboxDir).filter((f) => f.endsWith('.eml')).sort().map((f) => {
      const p = path.join(inboxDir, f);
      return { id: f.replace(/\.eml$/, ''), receivedAt: fs.statSync(p).mtime.toISOString(), base64: fs.readFileSync(p).toString('base64') };
    });
  }

  function ack(ids) {
    let n = 0;
    (ids || []).forEach((id) => {
      if (!/^[A-Za-z0-9.-]+$/.test(id)) return;
      const p = path.join(inboxDir, id + '.eml');
      if (fs.existsSync(p)) { fs.unlinkSync(p); n++; }
    });
    return { removed: n };
  }

  function watch(b) {
    const up = (a) => (a || []).map((x) => String(x));
    state.watch = { refs: up(b.refs).map((r) => r.toUpperCase()), emails: up(b.emails).map((e) => e.toLowerCase()), messageIds: up(b.messageIds), since: b.since || null };
    saveState();
    return { watching: state.watch.refs.length };
  }

  // ------------------------------------------------------------------- HTTP
  function httpError(code, message) { const e = new Error(message); e.status = code; return e; }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(httpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(httpError(400, 'Invalid JSON')); } });
      req.on('error', reject);
    });
  }

  const routes = {
    'GET /status': () => status(),
    'POST /config': (b) => setConfig(b),
    'POST /test': () => test(),
    'POST /send': (b) => send(b),
    'POST /watch': (b) => watch(b),
    'POST /check': () => check('manual'),
    'GET /replies': () => ({ replies: replies() }),
    'POST /replies/ack': (b) => ack(b.ids)
  };

  function allowedOrigin(origin) {
    return origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const port = server.address().port;
    const send = (code, obj) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (origin && allowedOrigin(origin)) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
      res.writeHead(code, headers);
      res.end(JSON.stringify(obj));
    };
    // DNS-rebinding guard: only accept requests addressed to this machine.
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return send(403, { error: 'Forbidden host' });
    if (origin && !allowedOrigin(origin)) return send(403, { error: 'Forbidden origin' });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || 'null', 'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-bnss-token',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600'
      });
      return res.end();
    }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/ping') return send(200, { app: 'bnss94-mail-helper', version: VERSION });
    if (!sameCode(req.headers['x-bnss-token'], config.code)) return send(401, { error: 'Wrong or missing pairing code' });
    const route = routes[req.method + ' ' + url];
    if (!route) return send(404, { error: 'Not found' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(200, await route(body));
    } catch (e) {
      send(e.status || 502, { error: e.message });
    }
  });

  return {
    get code() { return config.code; },
    get port() { return server.address() && server.address().port; },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port == null ? 8794 : opts.port, opts.host || '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() { clearInterval(timer); return new Promise((r) => server.close(r)); },
    check
  };
}

module.exports = { createHelper, VERSION };
