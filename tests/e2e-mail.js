#!/usr/bin/env node
/*
 * End-to-end test of automatic sending and reply pick-up:
 *   index.html (file://, headless Chromium)  ⇄  mail helper (127.0.0.1)  ⇄  mock SMTP/IMAP servers
 *
 * Pairs the app with the helper, saves mail settings through the UI, sends
 * every notice by e-mail, receives replies in the mock mailbox and checks that
 * the app picks them up (button and automatic polling), matches them to the
 * right notice and prompts. The page must not contact anything except the
 * helper on 127.0.0.1.
 *
 *   node tests/e2e-mail.js       (needs Playwright + Chromium, and openssl for the TLS mock servers)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'e2e-mail');
const M = require(path.join(ROOT, 'js/mail.js'));
const { createHelper } = require(path.join(ROOT, 'mail-helper/server.js'));
const { smtpServer, imapServer, selfSignedCert } = require('./mock-mail.js');
const sample = (f) => path.join(ROOT, 'samples', f);
const USER = 'cyber@police.example', PASS = 'synthetic-app-password';

async function closePrompt(page) { if (await page.$('#dlg-prompt[open]')) await page.click('#prompt-close'); }

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bnss94-e2e-mail-'));
  const cert = selfSignedCert(tmp);
  if (!cert) { console.log('e2e-mail skipped: openssl not available'); return; }
  const S = await smtpServer({ user: USER, pass: PASS, tls: cert, mode: 'starttls' });
  const I = await imapServer({ user: USER, pass: PASS, tls: cert, mode: 'implicit' });
  const H = createHelper({ dataDir: path.join(tmp, 'helper'), port: 0, log: () => {}, pollEveryMs: 3600000 });
  const hport = await H.start();

  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const errors = [], network = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob):/.test(u) && !u.startsWith('http://127.0.0.1:' + hport + '/')) network.push(u); });
  page.on('dialog', (d) => d.accept());
  await page.clock.install();
  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => document.querySelector('#cases tr'));

  // ---- Officer settings, nodal directory, case with FIR + export (as in tests/e2e.js)
  await page.click('#btn-settings');
  for (const [k, v] of Object.entries({ officerName: 'SI Synthetic Officer', designation: 'Sub-Inspector of Police', station: 'Cyber Crime Police Station, Testpur', phone: '0000000000', officerEmail: USER })) await page.fill('[name=' + k + ']', v);
  await page.click('#dlg-settings button[value=save]');
  await page.setInputFiles('#file-nodal', sample('sample_nodal_officers.xlsx'));
  await page.waitForSelector('#nodal-mapping:not(.hidden) select');
  await page.click('#btn-dir-save');
  await page.waitForFunction(() => /11 entries/.test(document.getElementById('dir-status').textContent));
  await page.click('#btn-new-case');
  await page.fill('#c-firNo', '123/2026'); await page.dispatchEvent('#c-firNo', 'change');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('save-status').textContent));
  await page.fill('#c-firDate', '01-03-2026'); await page.fill('#c-policeStation', 'Cyber Crime PS, Testpur'); await page.fill('#c-sections', '318(4) BNS');
  await page.setInputFiles('#file-fir', sample('sample_fir_copy.pdf'));
  await page.waitForFunction(() => /FIR_Copy/.test(document.getElementById('fir-file').textContent));
  await page.setInputFiles('#file-txn', sample('sample_ncrp_export.xlsx'));
  await page.waitForSelector('#mapping-box:not(.hidden)');
  await page.click('#btn-analyse');
  await page.waitForSelector('#step-generate:not(.hidden)');
  await page.selectOption('#bulk-tsp', 'Example Telecom Ltd');
  await page.click('#btn-bulk-tsp');
  assert.ok(await page.$eval('#btn-send-all', (b) => b.disabled), 'Send is disabled until the mail helper is set up');

  // ---- Pair with the helper and save mail settings through the UI
  await page.click('#btn-mail');
  await page.fill('#m-port', String(hport));
  await page.fill('#m-code', 'wrong-code-0000');
  await page.click('#m-connect');
  await page.waitForFunction(() => /Pairing code not accepted/.test(document.getElementById('m-conn').textContent));
  await page.fill('#m-code', H.code.toLowerCase());
  await page.click('#m-connect');
  await page.waitForSelector('#m-account:not(.hidden)');
  assert.strictEqual(await page.inputValue('#m-fromEmail'), USER, 'pre-filled from officer settings');
  await page.fill('#m-pass', PASS);
  await page.fill('#m-smtp-host', '127.0.0.1'); await page.fill('#m-smtp-port', String(S.port)); await page.selectOption('#m-smtp-sec', 'starttls');
  await page.fill('#m-imap-host', '127.0.0.1'); await page.fill('#m-imap-port', String(I.port)); await page.selectOption('#m-imap-sec', 'tls');
  await page.check('#m-selfsigned');
  await page.click('#m-test');
  await page.waitForFunction(() => /Sending \(SMTP\): OK · Mailbox \(IMAP\): OK/.test(document.getElementById('m-test-result').textContent));
  await page.screenshot({ path: path.join(OUT, 'mail-settings.png') });
  await page.click('#m-close');
  assert.strictEqual(await page.textContent('#mail-badge'), 'connected');
  assert.ok(!fs.readFileSync(path.join(tmp, 'helper', 'config.json'), 'utf8').includes(PASS), 'password not written to disk');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(PASS), 'password not stored in the browser');

  // ---- Send all notices by e-mail
  await page.waitForFunction(() => !document.getElementById('btn-send-all').disabled);
  await page.click('#btn-send-all');
  await page.waitForSelector('#dlg-prompt[open]', { timeout: 60000 });
  const sentPrompt = await page.$eval('#prompt-title', (e) => e.textContent);
  const sentLines = await page.$$eval('#prompt-body li', (l) => l.map((x) => x.textContent));
  assert.strictEqual(sentPrompt, 'Notices sent', sentLines.join('\n'));
  assert.strictEqual(sentLines.filter((l) => l.startsWith('✓ Sent')).length, 9, '9 recipients have an e-mail ID (6 banks, payment bank, TSP, 2 platforms; one bank has none)');
  await closePrompt(page);
  assert.strictEqual(S.messages.length, 9);
  assert.strictEqual(I.appended.length, 9, 'copies saved in Sent Items');
  const sf = S.messages.map((m) => ({ m, p: M.parseEml(m.raw) })).find((x) => /Sample Federal Bank/.test(x.p.subject));
  assert.deepStrictEqual(sf.m.to, ['le.cell@samplefederal.example', 'fraud@samplefederal.example']);
  assert.strictEqual(sf.p.fromEmail, USER);
  assert.deepStrictEqual(sf.p.attachments.map((a) => a.name.split('.').pop()), ['docx', 'pdf']);
  assert.ok(Buffer.from(sf.p.attachments[1].data).equals(fs.readFileSync(sample('sample_fir_copy.pdf'))), 'FIR copy attached');
  fs.writeFileSync(path.join(OUT, 'sent_sample_federal.eml'), sf.m.raw);
  const sfRef = sf.p.subject.match(M.REF_RE)[0];
  const sfMsgId = sf.p.headers['message-id'];
  const regStatuses = await page.$$eval('#register select', (s) => s.map((x) => x.value));
  assert.strictEqual(regStatuses.filter((v) => v === 'sent').length, 9);
  assert.strictEqual(await page.$$eval('#register .badge-ok', (b) => b.filter((x) => x.textContent === 'e-mailed').length), 9);
  assert.ok(await page.$eval('#emails tr:has-text("Sample Federal Bank") .btn-send', (b) => b.textContent === 'Send again'));
  await page.screenshot({ path: path.join(OUT, 'after-send.png'), fullPage: true });

  // The helper now watches the sent notices
  await page.clock.runFor(1000);
  await page.waitForFunction(() => true);
  const st = await (await fetch('http://127.0.0.1:' + hport + '/status', { headers: { 'X-BNSS-Token': H.code, Host: '127.0.0.1:' + hport } })).json();
  assert.strictEqual(st.watching, 9);

  // ---- Replies arrive in the mailbox
  const reply = (from, subject, extra, att) => M.buildEml({ fromName: 'Nodal Officer', fromEmail: from, to: [USER], subject, text: 'Please find the details attached.', unsent: false,
    attachments: att ? [{ name: att, type: 'application/pdf', data: Buffer.from('%PDF-1.4 synthetic reply') }] : [] }).replace('MIME-Version', (extra ? extra + '\r\n' : '') + 'MIME-Version');
  I.deliver(reply('newsletter@unrelated.example', 'Weekly newsletter'));
  // Bank officer changed the subject, but the reply is threaded to our message:
  I.deliver(reply('fraud@samplefederal.example', 'Documents for your request', 'In-Reply-To: ' + sfMsgId + '\r\nReferences: ' + sfMsgId, 'Statement_7766554433.pdf'));

  // "Check mailbox now" on the dashboard
  await page.click('#btn-back');
  await page.click('#btn-check-mail');
  await page.waitForSelector('#dlg-prompt[open]');
  const p1 = await page.$eval('#prompt-body', (b) => b.textContent);
  assert.ok(p1.includes('Reply received from Sample Federal Bank for FIR 123/2026 (' + sfRef + ') — 1 attachment(s) saved'), p1);
  await page.screenshot({ path: path.join(OUT, 'reply-prompt.png') });
  await closePrompt(page);
  assert.strictEqual(H.code && (await (await fetch('http://127.0.0.1:' + hport + '/replies', { headers: { 'X-BNSS-Token': H.code } })).json()).replies.length, 0, 'helper queue emptied after the app saved the reply');

  // ---- Automatic: the helper finds a reply on its own schedule; the app collects it within a minute
  const tel = S.messages.map((m) => M.parseEml(m.raw)).find((p) => /Example Telecom/.test(p.subject));
  I.deliver(reply('nodal@exampletelecom.example', 'RE: ' + tel.subject, null, 'CDR_9000000001.xlsx.pdf'));
  await H.check('scheduled');
  await page.clock.runFor(61000);
  await page.waitForSelector('#dlg-prompt[open]', { timeout: 15000 });
  const p2 = await page.$eval('#prompt-body', (b) => b.textContent);
  assert.ok(p2.includes('Reply received from Example Telecom Ltd'), p2);
  await closePrompt(page);

  // The same e-mail picked up twice (e.g. helper restarted before the ack) is recorded once
  I.deliver(reply('fraud@samplefederal.example', 'Documents for your request', 'In-Reply-To: ' + sfMsgId, 'Statement_7766554433.pdf').replace(/Message-ID: <[^>]+>/, 'Message-ID: <dup-test@samplefederal.example>'));
  I.deliver(reply('fraud@samplefederal.example', 'Documents for your request', 'In-Reply-To: ' + sfMsgId, 'Statement_7766554433.pdf').replace(/Message-ID: <[^>]+>/, 'Message-ID: <dup-test@samplefederal.example>'));
  await page.click('#btn-check-mail');
  await page.waitForSelector('#dlg-prompt[open]');
  await closePrompt(page);

  // ---- A reply that cannot be matched is kept until the user attaches it
  fs.writeFileSync(path.join(OUT, 'unmatched.eml'), reply('clerk@unknown-branch.example', 'Account details', null, 'KYC.pdf'));
  await page.setInputFiles('#file-reply', path.join(OUT, 'unmatched.eml'));
  await page.waitForSelector('#dlg-prompt[open]');
  assert.ok((await page.$eval('#prompt-body', (b) => b.textContent)).includes('could not be matched'));
  await closePrompt(page);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#cases tr'));
  await closePrompt(page);
  await page.waitForSelector('#reply-results select');
  const opt = await page.$eval('#reply-results select', (s, ref) => [...s.options].find((o) => o.textContent.includes(ref)).value, 'N94-123.2026-01');
  await page.selectOption('#reply-results select', opt);
  await page.click('#reply-results button:has-text("Attach to notice")');
  await page.waitForFunction(() => !document.querySelector('#reply-results select'));

  // ---- Register reflects everything
  await page.click('#cases button:has-text("123/2026")');
  await page.waitForSelector('#step-generate:not(.hidden)');
  const sfRow = await page.$eval('#register tr:has-text("' + sfRef + '")', (tr) => tr.textContent);
  assert.strictEqual((sfRow.match(/Statement_7766554433\.pdf/g) || []).length, 2, 'threaded reply + one copy of the duplicate pair');
  assert.ok((await page.$eval('#register tr:has-text("N94-123.2026-01")', (tr) => tr.textContent)).includes('KYC.pdf'), 'manually attached unmatched reply');
  assert.strictEqual(await page.$eval('#register tr:has-text("' + sfRef + '") select', (s) => s.value), 'replied');
  await page.screenshot({ path: path.join(OUT, 'register.png'), fullPage: true });

  assert.deepStrictEqual(network, [], 'the page contacted nothing but the local helper');
  assert.deepStrictEqual(errors, [], 'no console errors');
  await browser.close();
  await H.stop(); await S.close(); await I.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('e2e-mail ok — 9 notices sent by e-mail, replies picked up by thread, reference and sender; outputs in ' + path.relative(ROOT, OUT));
})().catch((e) => { console.error('e2e-mail FAILED:', e); process.exit(1); });
