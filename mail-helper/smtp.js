/*
 * Minimal SMTP client (no dependencies). Supports implicit TLS (port 465),
 * STARTTLS (port 587/25), AUTH PLAIN / LOGIN, multiple recipients and
 * dot-stuffing. Enough to submit mail to an organisation's own mail server.
 */
'use strict';
const net = require('net');
const tls = require('tls');

const TIMEOUT = 60000;

class SmtpError extends Error {
  constructor(stage, reply) { super('SMTP ' + stage + ' failed: ' + reply.text.replace(/\s+/g, ' ').slice(0, 300)); this.code = reply.code; }
}

/** Reads SMTP replies (with multi-line "250-..." continuation) from a socket. */
class Reader {
  constructor(sock) {
    this.buf = ''; this.lines = []; this.waiter = null; this.err = null;
    sock.on('data', (d) => { this.buf += d.toString('latin1'); this.pump(); });
    sock.on('error', (e) => { this.err = e; this.pump(); });
    sock.on('close', () => { this.err = this.err || new Error('SMTP connection closed'); this.pump(); });
  }
  pump() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) { this.lines.push(this.buf.slice(0, i).replace(/\r$/, '')); this.buf = this.buf.slice(i + 1); }
    if (!this.waiter) return;
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end >= 0) {
      const lines = this.lines.splice(0, end + 1);
      const w = this.waiter; this.waiter = null;
      w.resolve({ code: +lines[lines.length - 1].slice(0, 3), lines: lines.map((l) => l.slice(4)), text: lines.join('\n') });
    } else if (this.err) { const w = this.waiter; this.waiter = null; w.reject(this.err); }
  }
  reply() { return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.pump(); }); }
}

function tlsOptions(cfg, socket) {
  return { socket, host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false };
}

function rawConnect(cfg) {
  return new Promise((resolve, reject) => {
    const sock = cfg.secure ? tls.connect(tlsOptions(cfg)) : net.connect({ host: cfg.host, port: cfg.port });
    sock.once('error', reject);
    sock.once(cfg.secure ? 'secureConnect' : 'connect', () => { sock.removeListener('error', reject); resolve(sock); });
  });
}

function upgrade(cfg, plain) {
  ['data', 'error', 'close'].forEach((ev) => plain.removeAllListeners(ev));
  return new Promise((resolve, reject) => {
    const s = tls.connect(tlsOptions(cfg, plain), () => { s.removeListener('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

/**
 * Connect, greet, upgrade to TLS and log in.
 * @param cfg { host, port, secure, user, pass, rejectUnauthorized, allowPlain, heloName }
 * @returns { cmd(line, expectCodes, stage), write(data), reply(), close() }
 */
async function open(cfg) {
  cfg = Object.assign({}, cfg, { port: +cfg.port || (cfg.secure ? 465 : 587) });
  let sock = await rawConnect(cfg), reader;
  const arm = (s) => { s.setTimeout(TIMEOUT, () => s.destroy(new Error('SMTP connection timed out'))); reader = new Reader(s); };
  arm(sock);
  const s = {
    write: (data) => sock.write(data),
    reply: () => reader.reply(),
    async cmd(line, expect, stage) {
      if (line != null) sock.write(line + '\r\n');
      const rep = await reader.reply();
      if (expect && !expect.includes(rep.code)) throw new SmtpError(stage || String(line).split(' ')[0], rep);
      return rep;
    },
    close() { try { sock.write('QUIT\r\n'); sock.end(); } catch (e) { /* ignore */ } },
    destroy() { try { sock.destroy(); } catch (e) { /* ignore */ } }
  };
  try {
    const helo = 'EHLO ' + (cfg.heloName || 'bnss94.local');
    await s.cmd(null, [220], 'greeting');
    let ehlo = await s.cmd(helo, [250], 'EHLO');
    if (!cfg.secure) {
      if (ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
        await s.cmd('STARTTLS', [220]);
        sock = await upgrade(cfg, sock);
        arm(sock);
        ehlo = await s.cmd(helo, [250], 'EHLO');
      } else if (cfg.user && !cfg.allowPlain) {
        throw new Error('The SMTP server does not offer STARTTLS; refusing to send the password unencrypted. Use port 465 with SSL/TLS.');
      }
    }
    if (cfg.user) {
      const auth = (ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '').toUpperCase();
      const b64 = (x) => Buffer.from(String(x), 'utf8').toString('base64');
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await s.cmd('AUTH PLAIN ' + b64('\0' + cfg.user + '\0' + cfg.pass), [235], 'login');
      } else {
        await s.cmd('AUTH LOGIN', [334], 'login');
        await s.cmd(b64(cfg.user), [334], 'login');
        await s.cmd(b64(cfg.pass), [235], 'login');
      }
    }
    return s;
  } catch (e) {
    s.destroy();
    throw e;
  }
}

/**
 * Send one message.
 * @param env  { from, to: [..] }   envelope addresses
 * @param raw  string (CRLF message, e.g. from BNSSMail.buildEml)
 * @returns { accepted: [..], rejected: [{ rcpt, reason }], response }
 */
async function sendMail(cfg, env, raw) {
  const s = await open(cfg);
  try {
    await s.cmd('MAIL FROM:<' + env.from + '>', [250], 'MAIL FROM');
    const accepted = [], rejected = [];
    for (const rcpt of env.to) {
      const rep = await s.cmd('RCPT TO:<' + rcpt + '>');
      if (rep.code === 250 || rep.code === 251) accepted.push(rcpt); else rejected.push({ rcpt, reason: rep.text });
    }
    if (!accepted.length) throw new Error('All recipients were rejected: ' + rejected.map((x) => x.rcpt + ' (' + x.reason + ')').join('; '));
    await s.cmd('DATA', [354]);
    const body = String(raw).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    s.write(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n');
    const done = await s.cmd(null, [250], 'DATA');
    s.close();
    return { accepted, rejected, response: done.text };
  } catch (e) {
    s.destroy();
    throw e;
  }
}

/** Check that we can connect and log in (no mail is sent). */
async function verify(cfg) {
  const s = await open(cfg);
  s.close();
  return { ok: true };
}

module.exports = { sendMail, verify };
