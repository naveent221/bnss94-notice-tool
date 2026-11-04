/*
 * Minimal IMAP client (no dependencies): LOGIN, SELECT, UID SEARCH,
 * UID FETCH (BODY.PEEK — messages are not marked as read), LIST and APPEND.
 * Implicit TLS (port 993) or STARTTLS (port 143).
 */
'use strict';
const net = require('net');
const tls = require('tls');

const TIMEOUT = 90000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function imapDate(d) { return d.getUTCDate() + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear(); }

function quote(s) {
  s = String(s);
  if (/[^\x20-\x7e]/.test(s)) throw new Error('IMAP user name / password with non-ASCII characters are not supported');
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

class ImapConn {
  constructor(cfg) {
    this.cfg = Object.assign({}, cfg, { port: +cfg.port || (cfg.secure === false ? 143 : 993), secure: cfg.secure !== false });
    this.buf = Buffer.alloc(0); this.cur = null; this.tagN = 0;
    this.pending = null;   // { tag, untagged, resolve, reject }
    this.contWaiter = null; this.greetWaiter = null; this.err = null;
  }

  tlsOpts(socket) {
    return { socket, host: this.cfg.host, port: this.cfg.port, servername: net.isIP(this.cfg.host) ? undefined : this.cfg.host, rejectUnauthorized: this.cfg.rejectUnauthorized !== false };
  }

  attach(sock) {
    this.sock = sock;
    sock.setTimeout(TIMEOUT, () => sock.destroy(new Error('IMAP connection timed out')));
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('IMAP connection closed')));
  }

  fail(e) {
    this.err = this.err || e;
    [this.pending, this.contWaiter, this.greetWaiter].forEach((w) => { if (w) w.reject(this.err); });
    this.pending = this.contWaiter = this.greetWaiter = null;
  }

  async connect() {
    const c = this.cfg;
    const sock = await new Promise((resolve, reject) => {
      const s = c.secure ? tls.connect(this.tlsOpts()) : net.connect({ host: c.host, port: c.port });
      s.once('error', reject);
      s.once(c.secure ? 'secureConnect' : 'connect', () => { s.removeListener('error', reject); resolve(s); });
    });
    const greeting = new Promise((resolve, reject) => { this.greetWaiter = { resolve, reject }; });
    this.attach(sock);
    await greeting;
    if (!c.secure) {
      const cap = await this.exec('CAPABILITY');
      if (cap.untagged.some((u) => /STARTTLS/i.test(u.text))) {
        await this.exec('STARTTLS');
        ['data', 'error', 'close'].forEach((ev) => sock.removeAllListeners(ev));
        const t = await new Promise((resolve, reject) => {
          const s = tls.connect(this.tlsOpts(sock), () => { s.removeListener('error', reject); resolve(s); });
          s.once('error', reject);
        });
        this.buf = Buffer.alloc(0);
        this.attach(t);
      } else if (!c.allowPlain) {
        throw new Error('The IMAP server does not offer STARTTLS; refusing to send the password unencrypted. Use port 993 with SSL/TLS.');
      }
    }
    await this.exec('LOGIN ' + quote(c.user) + ' ' + quote(c.pass), 'login');
    return this;
  }

  /** Split the byte stream into responses; literals {n} are kept as Buffers. */
  parse() {
    for (;;) {
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = this.buf.slice(0, nl).toString('latin1');
      const m = line.match(/\{(\d+)\}$/);
      if (m) {
        const n = +m[1];
        if (this.buf.length < nl + 2 + n) return; // wait for the whole literal
        this.cur = this.cur || { text: '', literals: [] };
        this.cur.text += line + '\u0000' + this.cur.literals.length + '\u0000';
        this.cur.literals.push(this.buf.slice(nl + 2, nl + 2 + n));
        this.buf = this.buf.slice(nl + 2 + n);
        continue;
      }
      this.buf = this.buf.slice(nl + 2);
      const resp = this.cur || { text: '', literals: [] };
      resp.text += line; this.cur = null;
      this.dispatch(resp);
    }
  }

  dispatch(resp) {
    const t = resp.text;
    if (this.greetWaiter && /^\* (OK|PREAUTH)/i.test(t)) { const w = this.greetWaiter; this.greetWaiter = null; w.resolve(resp); return; }
    if (this.greetWaiter && /^\* BYE/i.test(t)) { const w = this.greetWaiter; this.greetWaiter = null; w.reject(new Error('IMAP server refused the connection: ' + t)); return; }
    if (t[0] === '+') { if (this.contWaiter) { const w = this.contWaiter; this.contWaiter = null; w.resolve(resp); } return; }
    if (t.startsWith('* ')) { if (this.pending) this.pending.untagged.push(resp); return; }
    const p = this.pending;
    if (p && t.startsWith(p.tag + ' ')) {
      this.pending = null;
      const status = t.slice(p.tag.length + 1);
      if (/^OK/i.test(status)) p.resolve({ untagged: p.untagged, status });
      else p.reject(new Error('IMAP ' + (p.stage || p.name) + ' failed: ' + status.slice(0, 300)));
    }
  }

  exec(command, stage, literal) {
    if (this.err) return Promise.reject(this.err);
    const tag = 'A' + (++this.tagN);
    const name = command.split(' ')[0];
    const done = new Promise((resolve, reject) => { this.pending = { tag, name, stage, untagged: [], resolve, reject }; });
    if (literal == null) {
      this.sock.write(tag + ' ' + command + '\r\n');
      return done;
    }
    // Command with a literal: send "{n}", wait for "+", then send the bytes.
    const cont = new Promise((resolve, reject) => { this.contWaiter = { resolve, reject }; });
    this.sock.write(tag + ' ' + command + ' {' + literal.length + '}\r\n');
    return cont.then(() => { this.sock.write(literal); this.sock.write('\r\n'); return done; });
  }

  async logout() {
    try { await this.exec('LOGOUT'); } catch (e) { /* ignore */ }
    try { this.sock.end(); } catch (e) { /* ignore */ }
  }

  destroy() { try { this.sock.destroy(); } catch (e) { /* ignore */ } }
}

async function withConnection(cfg, fn) {
  const c = new ImapConn(cfg);
  try {
    await c.connect();
    const r = await fn(c);
    await c.logout();
    return r;
  } catch (e) {
    c.destroy();
    throw e;
  }
}

/** Check that we can connect and log in. */
function verify(cfg) { return withConnection(cfg, async () => ({ ok: true })); }

function uidOf(resp) { const m = resp.text.match(/\bUID (\d+)/i); return m ? +m[1] : null; }

/**
 * Fetch new INBOX messages that pass `filter`.
 * @param opts { since: Date, lastUid, uidValidity, filter(headerBuffer) → boolean, max }
 * @returns { uidValidity, lastUid, scanned, messages: [{ uid, raw: Buffer }] }
 */
function fetchNew(cfg, opts) {
  return withConnection(cfg, async (c) => {
    const sel = await c.exec('SELECT ' + quote(cfg.mailbox || 'INBOX'), 'SELECT');
    let uidValidity = null;
    sel.untagged.forEach((u) => { const m = u.text.match(/UIDVALIDITY (\d+)/i); if (m) uidValidity = m[1]; });
    let lastUid = opts.uidValidity && opts.uidValidity === uidValidity ? +opts.lastUid || 0 : 0;
    const crit = 'UID ' + (lastUid + 1) + ':*' + (opts.since ? ' SINCE ' + imapDate(opts.since) : '');
    const search = await c.exec('UID SEARCH ' + crit, 'SEARCH');
    let uids = [];
    search.untagged.forEach((u) => { const m = u.text.match(/^\* SEARCH\s*(.*)$/i); if (m && m[1]) uids = uids.concat(m[1].trim().split(/\s+/).map(Number)); });
    uids = uids.filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, opts.max || 500);
    const out = { uidValidity, lastUid, scanned: uids.length, messages: [] };
    if (!uids.length) return out;

    const wanted = [];
    for (let i = 0; i < uids.length; i += 100) {
      const set = uids.slice(i, i + 100).join(',');
      const r = await c.exec('UID FETCH ' + set + ' (UID BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])', 'FETCH');
      r.untagged.forEach((u) => {
        const uid = uidOf(u);
        if (uid && u.literals[0] && opts.filter(u.literals[0])) wanted.push(uid);
      });
    }
    for (const uid of wanted) {
      const r = await c.exec('UID FETCH ' + uid + ' (UID BODY.PEEK[])', 'FETCH');
      const resp = r.untagged.find((u) => uidOf(u) === uid && u.literals.length);
      if (resp) out.messages.push({ uid, raw: resp.literals[resp.literals.length - 1] });
    }
    out.lastUid = Math.max(lastUid, uids[uids.length - 1]);
    return out;
  });
}

/** Save a copy of a sent message in the Sent folder (found by the \Sent flag, else "Sent"). */
function appendSent(cfg, raw) {
  return withConnection(cfg, async (c) => {
    let folder = cfg.sentFolder;
    if (!folder) {
      const list = await c.exec('LIST "" "*"', 'LIST');
      const hit = list.untagged.find((u) => /\\Sent\b/i.test(u.text));
      if (hit) {
        const m = hit.text.match(/"((?:[^"\\]|\\.)*)"\s*$/) || hit.text.match(/(\S+)\s*$/);
        folder = m ? m[1].replace(/\\(.)/g, '$1') : null;
      }
      folder = folder || 'Sent';
    }
    const bytes = Buffer.from(String(raw).replace(/\r?\n/g, '\r\n'), 'latin1');
    await c.exec('APPEND ' + quote(folder) + ' (\\Seen)', 'APPEND', bytes);
    return { folder };
  });
}

module.exports = { verify, fetchNew, appendSent, imapDate };
