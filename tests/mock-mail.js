/*
 * Tiny in-process SMTP and IMAP servers for tests. They implement just enough
 * of each protocol to exercise mail-helper/smtp.js and mail-helper/imap.js:
 * plain, implicit-TLS and STARTTLS connections, AUTH PLAIN/LOGIN, DATA with
 * dot-stuffing, IMAP LOGIN/SELECT/UID SEARCH/UID FETCH/LIST/APPEND.
 */
'use strict';
const net = require('net');
const tls = require('tls');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * @param opts { user, pass, tls: { key, cert } | null, mode: 'plain' | 'implicit' | 'starttls' }
 * @returns { port, messages: [{ from, to, raw }], close() }
 */
async function smtpServer(opts) {
  const messages = [];
  const handle = (sock, secured) => {
    let buf = '', state = 'cmd', data = '', from = '', to = [], authed = !opts.user, loginStep = 0, loginUser = '';
    const send = (l) => sock.write(l + '\r\n');
    send('220 mock.smtp ready');
    const onLine = (line) => {
      if (state === 'data') {
        if (line === '.') {
          messages.push({ from, to: to.slice(), raw: data });
          data = ''; state = 'cmd'; to = [];
          return send('250 2.0.0 Ok: queued as MOCK' + messages.length);
        }
        data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        return;
      }
      if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; return send('334 UGFzc3dvcmQ6'); }
      if (loginStep === 2) {
        loginStep = 0;
        authed = loginUser === opts.user && Buffer.from(line, 'base64').toString() === opts.pass;
        return send(authed ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed');
      }
      const [verb] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          sock.write('250-mock.smtp\r\n' + (opts.mode === 'starttls' && !secured ? '250-STARTTLS\r\n' : '') + '250-AUTH ' + (opts.loginOnly ? 'LOGIN' : 'PLAIN LOGIN') + '\r\n250 8BITMIME\r\n');
          return;
        case 'STARTTLS': {
          send('220 2.0.0 Ready to start TLS');
          sock.removeAllListeners('data');
          const t = new tls.TLSSocket(sock, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
          handleUpgraded(t);
          return;
        }
        case 'AUTH': {
          const parts = line.split(' ');
          if (parts[1].toUpperCase() === 'PLAIN') {
            const [, u, p] = Buffer.from(parts[2], 'base64').toString().split('\0');
            authed = u === opts.user && p === opts.pass;
            return send(authed ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed');
          }
          loginStep = 1; return send('334 VXNlcm5hbWU6');
        }
        case 'MAIL': if (!authed) return send('530 5.7.0 Authentication required'); from = (line.match(/<([^>]*)>/) || [])[1]; return send('250 2.1.0 Ok');
        case 'RCPT': {
          const r = (line.match(/<([^>]*)>/) || [])[1];
          if (/reject/.test(r)) return send('550 5.1.1 <' + r + '>: Recipient address rejected');
          to.push(r); return send('250 2.1.5 Ok');
        }
        case 'DATA': state = 'data'; return send('354 End data with <CR><LF>.<CR><LF>');
        case 'QUIT': send('221 2.0.0 Bye'); return sock.end();
        default: return send('502 5.5.2 Command not recognised');
      }
    };
    const handleUpgraded = (t) => { handle2(t); };
    const handle2 = (s) => {
      // After STARTTLS the session restarts on the TLS socket (state reset as per RFC 3207).
      sock = s; buf = ''; secured = true; authed = !opts.user;
      s.on('data', feed);
      s.on('error', () => {});
    };
    function feed(d) {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); }
    }
    sock.on('data', feed);
    sock.on('error', () => {});
  };
  const server = opts.mode === 'implicit'
    ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  const port = await listen(server);
  return { port, messages, close: () => new Promise((r) => server.close(r)) };
}

/**
 * @param opts { user, pass, tls, mode: 'plain' | 'implicit' | 'starttls', uidValidity }
 * @returns { port, inbox: [{ uid, raw: Buffer }], appended: [{ folder, raw }], deliver(raw), close() }
 */
async function imapServer(opts) {
  const inbox = [], appended = [];
  let nextUid = 1;
  const deliver = (raw) => { inbox.push({ uid: nextUid++, raw: Buffer.from(raw) }); };
  const headerOf = (raw) => { const s = raw.toString('latin1'); const i = s.search(/\r?\n\r?\n/); return Buffer.from((i >= 0 ? s.slice(0, i) : s) + '\r\n\r\n', 'latin1'); };

  const handle = (sock, secured) => {
    let buf = Buffer.alloc(0), authed = false, pendingAppend = null;
    const send = (l) => sock.write(l + '\r\n');
    send('* OK mock IMAP ready');
    const onLine = (line) => {
      const m = line.match(/^(\S+) (\S+)\s*(.*)$/);
      if (!m) return;
      const [, tag, verbRaw, rest] = m;
      const verb = verbRaw.toUpperCase();
      if (verb === 'CAPABILITY') { send('* CAPABILITY IMAP4rev1' + (opts.mode === 'starttls' && !secured ? ' STARTTLS' : '') + ' AUTH=PLAIN'); return send(tag + ' OK done'); }
      if (verb === 'STARTTLS') {
        send(tag + ' OK Begin TLS');
        sock.removeAllListeners('data');
        const t = new tls.TLSSocket(sock, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
        sock = t; buf = Buffer.alloc(0); secured = true;
        t.on('data', feed); t.on('error', () => {});
        return;
      }
      if (verb === 'LOGIN') {
        const args = rest.match(/"((?:[^"\\]|\\.)*)"/g).map((a) => a.slice(1, -1).replace(/\\(.)/g, '$1'));
        authed = args[0] === opts.user && args[1] === opts.pass;
        return send(tag + (authed ? ' OK LOGIN completed' : ' NO [AUTHENTICATIONFAILED] Invalid credentials'));
      }
      if (verb === 'LOGOUT') { send('* BYE'); send(tag + ' OK'); return sock.end(); }
      if (!authed) return send(tag + ' BAD not authenticated');
      if (verb === 'SELECT') { send('* ' + inbox.length + ' EXISTS'); send('* OK [UIDVALIDITY ' + (opts.uidValidity || 42) + '] UIDs valid'); return send(tag + ' OK [READ-WRITE] SELECT completed'); }
      if (verb === 'LIST') { send('* LIST (\\HasNoChildren) "/" "INBOX"'); send('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"'); return send(tag + ' OK LIST completed'); }
      if (verb === 'APPEND') {
        const am = rest.match(/^"((?:[^"\\]|\\.)*)".*\{(\d+)\}$/);
        pendingAppend = { tag, folder: am[1], n: +am[2] };
        return send('+ Ready for literal data');
      }
      if (verb === 'UID') {
        const sub = rest.split(' ')[0].toUpperCase();
        if (sub === 'SEARCH') {
          const r = rest.match(/UID (\d+):\*/i);
          const min = r ? +r[1] : 1;
          let hits = inbox.filter((x) => x.uid >= min).map((x) => x.uid);
          if (!hits.length && inbox.length) hits = [inbox[inbox.length - 1].uid]; // RFC 3501: n:* always includes the last message
          send('* SEARCH' + (hits.length ? ' ' + hits.join(' ') : ''));
          return send(tag + ' OK SEARCH completed');
        }
        if (sub === 'FETCH') {
          const set = rest.split(' ')[1].split(',').map(Number);
          const headers = /HEADER\.FIELDS/i.test(rest);
          set.forEach((uid) => {
            const msg = inbox.find((x) => x.uid === uid);
            if (!msg) return;
            const body = headers ? headerOf(msg.raw) : msg.raw;
            const seq = inbox.indexOf(msg) + 1;
            sock.write('* ' + seq + ' FETCH (UID ' + uid + ' BODY[' + (headers ? 'HEADER.FIELDS (SUBJECT FROM)' : '') + '] {' + body.length + '}\r\n');
            sock.write(body);
            sock.write(')\r\n');
          });
          return send(tag + ' OK FETCH completed');
        }
      }
      return send(tag + ' BAD unknown command');
    };
    function feed(d) {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (pendingAppend) {
          if (buf.length < pendingAppend.n + 2) return;
          appended.push({ folder: pendingAppend.folder, raw: buf.slice(0, pendingAppend.n).toString('latin1') });
          buf = buf.slice(pendingAppend.n + 2);
          send(pendingAppend.tag + ' OK APPEND completed');
          pendingAppend = null;
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i).toString('latin1');
        buf = buf.slice(i + 2);
        onLine(line);
      }
    }
    sock.on('data', feed);
    sock.on('error', () => {});
  };
  const server = opts.mode === 'implicit'
    ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  const port = await listen(server);
  return { port, inbox, appended, deliver, close: () => new Promise((r) => server.close(r)) };
}

/** Self-signed certificate for the TLS tests (needs the openssl command). */
function selfSignedCert(dir) {
  const { execFileSync } = require('child_process');
  const fs = require('fs'), path = require('path');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch (e) {
    return null;
  }
}

module.exports = { smtpServer, imapServer, selfSignedCert };
