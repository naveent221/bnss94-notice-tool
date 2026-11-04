#!/usr/bin/env node
/*
 * End-to-end check of the whole Phase 1 flow in headless Chromium, with the
 * page opened straight from disk (file://):
 *
 *   nodal directory → new case (FIR) → mandatory-field prompts → FIR copy +
 *   NCRP export → Layer 1 analysis → phone / URL / social identifiers →
 *   recipients → ZIP (notices, e-mail drafts, FIR copy, Excel) → mark sent →
 *   reply e-mail imported → "reply received" prompt → data still there after a
 *   reload → overdue alert → backup.
 *
 * Also asserts that the page made no network requests and logged no errors.
 *
 *   node tests/e2e.js            (needs Playwright + Chromium installed)
 *
 * Output files are written to output/e2e/ (git-ignored).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'e2e');
const JSZip = require(path.join(ROOT, 'vendor/jszip.min.js'));
const XLSX = require(path.join(ROOT, 'vendor/xlsx.full.min.js'));
const M = require(path.join(ROOT, 'js/mail.js'));
const sample = (f) => path.join(ROOT, 'samples', f);

async function closePrompt(page) {
  if (await page.$('#dlg-prompt[open]')) await page.click('#prompt-close');
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const errors = [], network = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) network.push(r.url()); });
  page.on('dialog', (d) => d.accept());

  const url = 'file://' + path.join(ROOT, 'index.html');
  await page.goto(url);
  await page.waitForFunction(() => window.BNSS && window.BNSSStore && window.BNSSStore.persistent !== undefined && document.querySelector('#cases tr'));
  assert.ok(await page.evaluate(() => window.BNSSStore.persistent), 'IndexedDB works from file://');

  // ---- Officer settings
  await page.click('#btn-settings');
  await page.fill('[name=officerName]', 'SI Synthetic Officer');
  await page.fill('[name=designation]', 'Sub-Inspector of Police');
  await page.fill('[name=station]', 'Cyber Crime Police Station, Testpur');
  await page.fill('[name=phone]', '0000000000');
  await page.fill('[name=officerEmail]', 'cyber@police.example');
  await page.click('#dlg-settings button[value=save]');
  await page.waitForFunction(() => localStorage.getItem('bnss94.settings'));

  // ---- Nodal directory (once, shared by all cases)
  await page.setInputFiles('#file-nodal', sample('sample_nodal_officers.xlsx'));
  await page.waitForSelector('#nodal-mapping:not(.hidden) select');
  await page.click('#btn-dir-save');
  await page.waitForFunction(() => /11 entries/.test(document.getElementById('dir-status').textContent));

  // ---- New case: mandatory prompts before anything is filled
  await page.click('#btn-new-case');
  await page.waitForSelector('#view-case:not(.hidden)');
  const missingAtStart = await page.$$eval('#checklist li.miss', (l) => l.map((x) => x.textContent));
  ['FIR number', 'FIR date', 'Police station', 'Sections of law', 'FIR copy', 'NCRP transaction export'].forEach((f) =>
    assert.ok(missingAtStart.some((t) => t.includes(f)), 'prompt for ' + f));

  await page.fill('#c-firNo', '123/2026');
  await page.dispatchEvent('#c-firNo', 'change');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('save-status').textContent));
  await page.fill('#c-firDate', '01-03-2026');
  await page.fill('#c-policeStation', 'Cyber Crime PS, Testpur');
  await page.fill('#c-sections', '318(4) BNS; 66D IT Act');
  await page.fill('#c-periodFrom', '01-02-2026');
  await page.fill('#c-periodTo', '31-03-2026');
  await page.setInputFiles('#file-fir', sample('sample_fir_copy.pdf'));
  await page.waitForFunction(() => /FIR_Copy_123_2026\.pdf/.test(document.getElementById('fir-file').textContent));

  await page.setInputFiles('#file-txn', sample('sample_ncrp_export.xlsx'));
  await page.waitForSelector('#mapping-box:not(.hidden)');
  assert.strictEqual(await page.$$eval('#txn-map select', (s) => s.filter((x) => x.value).length), 13, 'all 13 columns auto-mapped');
  await page.click('#btn-analyse');
  await page.waitForSelector('#step-results:not(.hidden)');
  assert.strictEqual(await page.$$eval('#checklist li.miss', (l) => l.filter((x) => /FIR|Police|Sections|export/.test(x.textContent)).length), 0, 'case fields complete');

  // ---- Layer 1 results + total loss / hold
  const rows = await page.$$eval('#results tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim())));
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(rows[0][2], '000112233445566');
  const tiles = await page.$eval('#stats', (s) => s.textContent);
  assert.ok(tiles.includes('3,03,699.50') && tiles.includes('61,000.00'), 'total loss and put-on-hold shown');

  // ---- Identifiers: phones need an operator, URLs/handles matched by domain
  assert.strictEqual(await page.$$eval('#identifiers tr', (t) => t.length - 1), 9);
  await page.selectOption('#bulk-tsp', 'Example Telecom Ltd');
  await page.click('#btn-bulk-tsp');
  await page.fill('#id-add', '9000000099');
  await page.selectOption('#id-add-hint', 'phone');
  await page.fill('#id-add-acks', '99900000000101');
  await page.click('#btn-id-add');
  assert.strictEqual(await page.$$eval('#identifiers tr', (t) => t.length - 1), 10, 'manual identifier added');
  const newRow = await page.$('#identifiers tr:has-text("9000000099") select');
  await newRow.selectOption('Demo Mobile Networks');
  const unassigned = await page.$$eval('#banks tr.unmatched', (t) => t.map((r) => r.textContent));
  assert.ok(unassigned.some((t) => /Nowhere Rural Bank/.test(t)), 'unmatched bank prompted');
  assert.ok(await page.$$eval('#checklist li.miss', (l) => l.some((x) => /No nodal officer chosen for Unassigned URL/.test(x.textContent))), 'unassigned URL prompted');

  // Telecom recipient gets CDR/SDR/IPDR ticked, not AOF
  const telReq = await page.$eval('#banks tr:has-text("Example Telecom Ltd")', (tr) => [...tr.querySelectorAll('.reqchip')].filter((l) => l.querySelector('input').checked).map((l) => l.textContent.trim()));
  assert.deepStrictEqual(telReq, ['KYC details', 'Photographs', 'Aadhaar', 'CDR', 'SDR / CAF', 'IPDR']);
  await page.screenshot({ path: path.join(OUT, 'case.png'), fullPage: true });

  // ---- Generate
  const sendable = await page.$$eval('#emails tr', (t) => t.length - 1);
  assert.strictEqual(sendable, 11, '7 banks/payment + 2 TSPs + 2 platforms');
  await page.click('#emails tr:has-text("Example Telecom Ltd") button:has-text("Preview")');
  const preview = await page.$eval('#preview-body', (p) => p.textContent);
  assert.ok(preview.includes('Call Detail Records') && preview.includes('9000000001') && preview.includes('FIR No. 123/2026 dated 01-03-2026'));
  await page.screenshot({ path: path.join(OUT, 'preview.png') });
  await page.click('#preview-close');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-zip')]);
  const zipPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(zipPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const docs = files.filter((n) => n.endsWith('.docx')), emls = files.filter((n) => n.endsWith('.eml'));
  assert.strictEqual(docs.length, 11);
  assert.strictEqual(emls.length, 10, 'no draft for the bank without e-mail');
  assert.ok(files.includes('FIR_Copy_123_2026.pdf'));
  for (const d of docs.concat(emls)) fs.writeFileSync(path.join(OUT, path.basename(d)), await zip.file(d).async('nodebuffer'));
  const xbuf = await zip.file('BNSS94_Summary.xlsx').async('nodebuffer');
  fs.writeFileSync(path.join(OUT, 'BNSS94_Summary.xlsx'), xbuf);
  assert.ok(XLSX.read(xbuf).SheetNames.includes('Identifiers'));
  const sfDraft = M.parseEml(await zip.file(emls.find((n) => /Sample_Federal/.test(n))).async('uint8array'));
  const sfRef = sfDraft.subject.match(M.REF_RE)[0];
  assert.deepStrictEqual(sfDraft.attachments.map((a) => a.name.split('.').pop()), ['docx', 'pdf']);

  // ---- Register: 11 notices, mark all sent → due dates set
  assert.strictEqual(await page.$$eval('#register tr', (t) => t.length - 1), 11);
  await page.click('#btn-mark-all-sent');
  assert.strictEqual(await page.$$eval('#register select', (s) => s.filter((x) => x.value === 'sent').length), 11);
  await page.waitForFunction(() => /Saved/.test(document.getElementById('save-status').textContent));

  // ---- A reply arrives (saved from the mail client as .eml)
  const reply = M.buildEml({ fromName: 'Nodal Officer', fromEmail: 'le.cell@samplefederal.example', to: ['cyber@police.example'],
    subject: 'RE: ' + sfDraft.subject, text: 'Please find the account statement and KYC attached.', unsent: false,
    attachments: [{ name: 'Statement_7766554433.pdf', type: 'application/pdf', data: fs.readFileSync(sample('sample_fir_copy.pdf')) }] });
  const replyPath = path.join(OUT, 'reply_from_bank.eml');
  fs.writeFileSync(replyPath, reply);
  await page.click('#btn-back');
  await page.waitForSelector('#view-dashboard:not(.hidden)');
  await page.setInputFiles('#file-reply', replyPath);
  await page.waitForSelector('#dlg-prompt[open]');
  const promptText = await page.$eval('#prompt-body', (b) => b.textContent);
  assert.ok(promptText.includes('Reply received from Sample Federal Bank for FIR 123/2026 (' + sfRef + ') — 1 attachment(s) saved'), promptText);
  await page.screenshot({ path: path.join(OUT, 'reply-prompt.png') });
  await closePrompt(page);
  assert.ok(await page.$$eval('#alerts li', (l) => l.some((x) => /Reply received from Sample Federal Bank/.test(x.textContent))));

  // ---- Persistence: reload, case still there with the reply; start-up prompt shown
  await page.reload();
  await page.waitForSelector('#dlg-prompt[open]');
  assert.ok((await page.$eval('#prompt-body', (b) => b.textContent)).includes('Reply received from Sample Federal Bank'));
  await closePrompt(page);
  await page.click('#cases button:has-text("123/2026")');
  await page.waitForSelector('#step-results:not(.hidden)');
  assert.strictEqual(await page.$$eval('#results tbody tr', (t) => t.length), 10, 'analysis restored from storage');
  assert.strictEqual(await page.$$eval('#identifiers tr', (t) => t.length - 1), 10, 'manual identifier restored');
  const regRow = await page.$eval('#register tr:has-text("' + sfRef + '")', (tr) => tr.textContent);
  assert.ok(regRow.includes('Statement_7766554433.pdf'), 'reply attachment listed');
  assert.strictEqual(await page.$eval('#register tr:has-text("' + sfRef + '") select', (s) => s.value), 'replied');
  const [att] = await Promise.all([page.waitForEvent('download'), page.click('#register button:has-text("Statement_7766554433.pdf")')]);
  await att.saveAs(path.join(OUT, 'saved_reply_attachment.pdf'));
  assert.ok(fs.readFileSync(path.join(OUT, 'saved_reply_attachment.pdf')).equals(fs.readFileSync(sample('sample_fir_copy.pdf'))));

  // ---- Overdue alert: pretend the due date passed
  await page.evaluate(async () => {
    const c = await window.BNSSStore.get('cases', '123/2026');
    c.notices.forEach((n) => { if (n.status === 'sent') n.dueAt = new Date(Date.now() - 2 * 864e5).toISOString(); });
    await window.BNSSStore.put('cases', c);
  });
  await page.reload();
  await page.waitForSelector('#dlg-prompt[open]');
  const startup = await page.$eval('#prompt-body', (b) => b.textContent);
  assert.ok(/No reply from Example National Bank .* was due/.test(startup), 'overdue prompt');
  await closePrompt(page);
  assert.strictEqual(await page.$eval('#cases tr:has-text("123/2026") td:nth-child(8)', (td) => td.textContent), '10', '10 overdue notices');
  await page.screenshot({ path: path.join(OUT, 'dashboard.png'), fullPage: true });

  // ---- Backup
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#btn-backup')]);
  const bkPath = path.join(OUT, bk.suggestedFilename());
  await bk.saveAs(bkPath);
  const backup = JSON.parse(fs.readFileSync(bkPath, 'utf8'));
  assert.strictEqual(backup.cases.length, 1);
  assert.ok(backup.files.some((f) => f.kind === 'fir') && backup.files.some((f) => f.kind === 'reply'));

  // ---- Restore into a fresh browser profile
  const ctx2 = await browser.newContext({ acceptDownloads: true });
  const p2 = await ctx2.newPage();
  p2.on('dialog', (d) => d.accept());
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(url);
  await p2.waitForFunction(() => document.querySelector('#cases tr'));
  await p2.setInputFiles('#file-restore', bkPath);
  await p2.waitForSelector('#cases button:has-text("123/2026")');
  await ctx2.close();

  assert.deepStrictEqual(network, [], 'no network requests');
  assert.deepStrictEqual(errors, [], 'no console errors');
  await browser.close();
  console.log('e2e ok — ' + docs.length + ' notices, ' + emls.length + ' e-mail drafts, reply matched to ' + sfRef + '; outputs in ' + path.relative(ROOT, OUT));
})().catch((e) => { console.error('e2e FAILED:', e); process.exit(1); });
