#!/usr/bin/env node
/*
 * BNSS94 mail helper — start this on the officer's computer to let the
 * BNSS94 Notice Tool send notices and collect replies through the officer's
 * own mailbox (SMTP + IMAP). Needs Node.js 18 or newer; no other installs.
 *
 *   node mail-helper.js [--port 8794] [--data-dir DIR] [--new-code]
 *
 * Keep this window open while you work. Close it (or Ctrl+C) to stop.
 */
'use strict';
const os = require('os');
const path = require('path');
const { createHelper } = require('./server');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const major = +process.versions.node.split('.')[0];
if (major < 18) { console.error('Node.js 18 or newer is needed (found ' + process.version + ').'); process.exit(1); }

const dataDir = arg('data-dir', process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'BNSS94MailHelper')
  : path.join(os.homedir(), '.bnss94-mail-helper'));
const port = +arg('port', 8794);

const helper = createHelper({ dataDir, port, newCode: !!arg('new-code', false) });
helper.start().then((p) => {
  const line = '='.repeat(64);
  console.log(line);
  console.log('  BNSS94 mail helper is running on this computer (127.0.0.1:' + p + ')');
  console.log('');
  console.log('  Pairing code:  ' + helper.code);
  console.log('');
  console.log('  In the Notice Tool click "Mail", enter this code, then fill in');
  console.log('  your mail server settings. Keep this window open while you work.');
  console.log('  Settings folder: ' + dataDir);
  console.log(line);
}).catch((e) => {
  if (e.code === 'EADDRINUSE') console.error('Port ' + port + ' is already in use — is the helper already running? (use --port to pick another)');
  else console.error('Could not start: ' + e.message);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\nStopping…'); helper.stop().then(() => process.exit(0)); });
