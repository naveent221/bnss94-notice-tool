#!/usr/bin/env node
/*
 * Tests for the local mail helper (mail-helper/) against in-process mock SMTP
 * and IMAP servers: security checks, settings, sending (plain, implicit TLS,
 * STARTTLS), Sent-folder copy, reply pick-up and restart behaviour.
 *
 *   node tests/mail-helper-tests.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { createHelper } = require(path.join(ROOT, 'mail-helper/server.js'));
const smtp = require(path.join(ROOT, 'mail-helper/smtp.js'));
const imap = require(path.join(ROOT, 'mail-helper/imap.js'));
const M = require(path.join(ROOT, 'js/mail.js'));
const { smtpServer, imapServer, selfSignedCert } = require('./mock-mail.js');

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Raw HTTP request so we can set Host / Origin headers freely. */
function request(port, method, url, { body, token, host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Host: host || '127.0.0.1:' + port };
    if (token) headers['X-BNSS-Token'] = token;
    if (origin) headers.Origin = origin;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bnss94-helper-'));
const cert = selfSignedCert(tmp);
const USER = 'cyber@police.example', PASS = 'p@ss "word"\\1';
let S, I, H, port, code;
const api = (method, url, body) => request(port, method, url, { body, token: code, origin: 'null' });

async function setup() {
  S = await smtpServer({ user: USER, pass: PASS, tls: cert, mode: cert ? 'starttls' : 'plain' });
  I = await imapServer({ user: USER, pass: PASS, tls: cert, mode: cert ? 'implicit' : 'plain' });
  H = createHelper({ dataDir: path.join(tmp, 'data'), port: 0, log: () => {}, pollEveryMs: 3600000 });
  port = await H.start();
  code = H.code;
}

const mailCfg = () => ({
  user: USER, pass: PASS, fromEmail: USER, fromName: 'SI Synthetic Officer', pollMinutes: 5,
  smtp: { host: '127.0.0.1', port: S.port, secure: false, rejectUnauthorized: false, allowPlain: !cert },
  imap: { host: '127.0.0.1', port: I.port, secure: !!cert, rejectUnauthorized: false, allowPlain: !cert }
});

// ------------------------------------------------------------------ security
test('ping works without a code; everything else needs the pairing code', async () => {
  assert.strictEqual((await request(port, 'GET', '/ping')).json.app, 'bnss94-mail-helper');
  assert.strictEqual((await request(port, 'GET', '/status')).status, 401);
  assert.strictEqual((await request(port, 'GET', '/status', { token: 'AAAA-BBBB-CCCC' })).status, 401);
  assert.strictEqual((await request(port, 'GET', '/status', { token: code.toLowerCase().replace(/-/g, '') })).status, 200, 'code is case/dash-insensitive');
  assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
});
test('requests for another host name (DNS rebinding) or from other web origins are refused', async () => {
  assert.strictEqual((await request(port, 'GET', '/status', { token: code, host: 'evil.example:' + port })).status, 403);
  assert.strictEqual((await request(port, 'GET', '/status', { token: code, origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await request(port, 'GET', '/status', { token: code, origin: 'null' })).status, 200, 'file:// pages send Origin: null');
});
test('CORS preflight allows the app (incl. Chrome private-network access)', async () => {
  const r = await request(port, 'OPTIONS', '/send', { origin: 'null' });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers['access-control-allow-origin'], 'null');
  assert.strictEqual(r.headers['access-control-allow-private-network'], 'true');
  assert.ok(/x-bnss-token/.test(r.headers['access-control-allow-headers']));
});

// ------------------------------------------------------------------ settings
test('settings are saved; the password is kept in memory unless "remember" is ticked', async () => {
  const st = (await api('POST', '/config', mailCfg())).json;
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.hasPassword, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'config.json'), 'utf8'));
  assert.strictEqual(onDisk.pass, undefined, 'password not written to disk');
  assert.strictEqual(onDisk.user, USER);
  assert.strictEqual(JSON.stringify((await api('GET', '/status')).json).includes(PASS), false, 'status never returns the password');
});
test('connection test logs in to SMTP and IMAP; a wrong password is reported', async () => {
  assert.deepStrictEqual((await api('POST', '/test')).json, { smtp: { ok: true }, imap: { ok: true } });
  await api('POST', '/config', { pass: 'wrong' });
  const bad = (await api('POST', '/test')).json;
  assert.strictEqual(bad.smtp.ok, false); assert.ok(/login failed/i.test(bad.smtp.error));
  assert.strictEqual(bad.imap.ok, false); assert.ok(/login failed/i.test(bad.imap.error));
  await api('POST', '/config', { pass: PASS });
});

// ------------------------------------------------------------------- sending
let sent;
test('sends a notice with attachments through SMTP and keeps a copy in Sent', async () => {
  const docx = Buffer.alloc(4000, 7), fir = Buffer.from('%PDF-1.4 synthetic');
  const r = await api('POST', '/send', {
    ref: 'N94-123.2026-04', to: ['le.cell@samplefederal.example', 'fraud@samplefederal.example'],
    subject: 'Notice u/s 94 BNSS – Sample Federal Bank [Ref: N94-123.2026-04]', text: 'Sir/Madam,\n.\nPlease find attached.',
    attachments: [{ name: 'notice.docx', type: 'application/octet-stream', base64: docx.toString('base64') }, { name: 'FIR.pdf', type: 'application/pdf', base64: fir.toString('base64') }]
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  sent = r.json;
  assert.deepStrictEqual(sent.accepted, ['le.cell@samplefederal.example', 'fraud@samplefederal.example']);
  assert.ok(/^<n94-123\.2026-04\.[0-9a-f]{12}@police\.example>$/.test(sent.messageId));
  assert.strictEqual(sent.savedToSent, 'Sent Items');
  assert.strictEqual(S.messages.length, 1);
  const got = M.parseEml(S.messages[0].raw);
  assert.strictEqual(got.subject, 'Notice u/s 94 BNSS – Sample Federal Bank [Ref: N94-123.2026-04]');
  assert.strictEqual(got.text.replace(/\r/g, ''), 'Sir/Madam,\n.\nPlease find attached.', 'dot-stuffing round-trips');
  assert.ok(Buffer.from(got.attachments[0].data).equals(docx) && Buffer.from(got.attachments[1].data).equals(fir));
  assert.ok(!/X-Unsent/.test(S.messages[0].raw), 'real mail is not marked as a draft');
  assert.strictEqual(I.appended.length, 1);
});
test('a rejected recipient is reported, the others still receive it', async () => {
  const r = (await api('POST', '/send', { ref: 'N94-X-01', to: ['ok@bank.example', 'reject@bank.example'], subject: 's', text: 't' })).json;
  assert.deepStrictEqual(r.accepted, ['ok@bank.example']);
  assert.strictEqual(r.rejected[0].rcpt, 'reject@bank.example');
});

// ------------------------------------------------------------------- replies
test('replies are picked up by reference, by thread (In-Reply-To) or by sender; other mail is ignored', async () => {
  await api('POST', '/watch', { refs: ['N94-123.2026-04', 'N94-123.2026-09'], emails: ['le.cell@samplefederal.example', 'lea@samplesocial.example'],
    messageIds: [sent.messageId], since: new Date().toISOString() });
  const reply = (from, subject, extra) => M.buildEml({ fromEmail: from, to: [USER], subject, text: 'reply', unsent: false }).replace('MIME-Version', (extra ? extra + '\r\n' : '') + 'MIME-Version');
  I.deliver(reply('someone@else.example', 'Lunch?'));
  I.deliver(reply('le.cell@samplefederal.example', 'RE: Notice u/s 94 BNSS – Sample Federal Bank [Ref: N94-123.2026-04]'));
  I.deliver(reply('fraud@samplefederal.example', 'Statement attached', 'In-Reply-To: ' + sent.messageId));
  I.deliver(reply('lea@samplesocial.example', 'Your request'));
  const c = (await api('POST', '/check')).json;
  assert.deepStrictEqual(c, { scanned: 4, found: 3 });
  const r = (await api('GET', '/replies')).json.replies;
  assert.strictEqual(r.length, 3);
  const subjects = r.map((x) => M.parseEml(Buffer.from(x.base64, 'base64')).subject).sort();
  assert.deepStrictEqual(subjects, ['RE: Notice u/s 94 BNSS – Sample Federal Bank [Ref: N94-123.2026-04]', 'Statement attached', 'Your request']);
  // The app matches each one to its notice:
  const notices = [{ ref: 'N94-123.2026-04', emails: ['le.cell@samplefederal.example', 'fraud@samplefederal.example'], messageId: sent.messageId },
    { ref: 'N94-123.2026-09', emails: ['lea@samplesocial.example'] }];
  const methods = r.map((x) => M.matchReply(M.parseEml(Buffer.from(x.base64, 'base64')), notices)).map((m) => m.notice.ref + ':' + m.method).sort();
  assert.deepStrictEqual(methods, ['N94-123.2026-04:ref', 'N94-123.2026-04:thread', 'N94-123.2026-09:sender']);
  assert.deepStrictEqual((await api('POST', '/replies/ack', { ids: r.map((x) => x.id).concat(['../../etc/passwd']) })).json, { removed: 3 });
  assert.strictEqual((await api('GET', '/replies')).json.replies.length, 0);
  assert.strictEqual((await api('GET', '/status')).json.lastError, null);
});
test('already-seen mail is not picked up twice; new replies are', async () => {
  assert.deepStrictEqual((await api('POST', '/check')).json, { scanned: 0, found: 0 });
  I.deliver(M.buildEml({ fromEmail: 'x@y.example', to: [USER], subject: 'Re: [Ref: N94-123.2026-09] partial reply', text: 'r', unsent: false }));
  assert.deepStrictEqual((await api('POST', '/check')).json, { scanned: 1, found: 1 });
});
test('after a restart: same pairing code, same mailbox position, password asked again unless remembered', async () => {
  const old = code;
  await H.stop();
  H = createHelper({ dataDir: path.join(tmp, 'data'), port: 0, log: () => {}, pollEveryMs: 3600000 });
  port = await H.start();
  assert.strictEqual(H.code, old);
  const st = (await api('GET', '/status')).json;
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.hasPassword, false, 'password was not remembered');
  assert.strictEqual((await api('POST', '/send', { to: ['a@b.example'], subject: 's', text: 't' })).status, 409);
  await api('POST', '/config', { pass: PASS, rememberPassword: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'config.json'), 'utf8')).pass, PASS, 'remembered on request');
  assert.deepStrictEqual((await api('POST', '/check')).json, { scanned: 0, found: 0 }, 'no duplicates after restart');
  assert.strictEqual((await api('GET', '/replies')).json.replies.length, 1, 'uncollected reply survives a restart');
});
test('--new-code style reset issues a different pairing code', async () => {
  await H.stop();
  H = createHelper({ dataDir: path.join(tmp, 'data'), port: 0, log: () => {}, newCode: true, pollEveryMs: 3600000 });
  port = await H.start();
  assert.notStrictEqual(H.code, code);
  assert.strictEqual((await api('GET', '/status')).status, 401, 'old code no longer works');
  code = H.code;
});

// ------------------------------------------------------- client edge cases
test('SMTP: refuses to send a password over an unencrypted connection', async () => {
  const plain = await smtpServer({ user: USER, pass: PASS, mode: 'plain' });
  await assert.rejects(smtp.verify({ host: '127.0.0.1', port: plain.port, secure: false, user: USER, pass: PASS }), /unencrypted/);
  await plain.close();
});
test('SMTP: AUTH LOGIN when the server does not offer PLAIN; implicit TLS (port 465 style)', async () => {
  if (!cert) return console.log('       (skipped: openssl not available)');
  const s = await smtpServer({ user: USER, pass: PASS, tls: cert, mode: 'implicit', loginOnly: true });
  const r = await smtp.sendMail({ host: '127.0.0.1', port: s.port, secure: true, user: USER, pass: PASS, rejectUnauthorized: false }, { from: USER, to: ['a@b.example'] }, 'Subject: x\r\n\r\nhi');
  assert.deepStrictEqual(r.accepted, ['a@b.example']);
  await s.close();
});
test('TLS certificates are verified by default', async () => {
  if (!cert) return console.log('       (skipped: openssl not available)');
  const s = await smtpServer({ user: USER, pass: PASS, tls: cert, mode: 'implicit' });
  await assert.rejects(smtp.verify({ host: '127.0.0.1', port: s.port, secure: true, user: USER, pass: PASS }), /self[- ]signed|certificate/i);
  await s.close();
});
test('IMAP: STARTTLS on port 143 style servers', async () => {
  if (!cert) return console.log('       (skipped: openssl not available)');
  const i = await imapServer({ user: USER, pass: PASS, tls: cert, mode: 'starttls' });
  assert.deepStrictEqual(await imap.verify({ host: '127.0.0.1', port: i.port, secure: false, user: USER, pass: PASS, rejectUnauthorized: false }), { ok: true });
  await i.close();
});

(async () => {
  console.log('BNSS94 mail helper — tests' + (cert ? '' : ' (no openssl: TLS tests skipped)') + '\n');
  await setup();
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  await H.stop(); await S.close(); await I.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
