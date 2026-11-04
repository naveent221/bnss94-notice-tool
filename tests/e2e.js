#!/usr/bin/env node
/*
 * End-to-end check: opens index.html straight from disk (file://) in headless
 * Chromium, loads the synthetic samples, analyses, downloads the ZIP and checks
 * its contents. Also asserts that the page made no network requests.
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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const errors = [], network = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) network.push(r.url()); });
  page.on('dialog', (d) => d.accept());

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => window.BNSS && window.BNSSOutputs && window.docx && window.XLSX && window.JSZip);

  // Officer settings (stored in localStorage)
  await page.click('#btn-settings');
  await page.fill('[name=officerName]', 'SI Synthetic Officer');
  await page.fill('[name=designation]', 'Sub-Inspector of Police');
  await page.fill('[name=station]', 'Cyber Crime Police Station, Testpur');
  await page.fill('[name=phone]', '0000000000');
  await page.fill('[name=officerEmail]', 'cyber@police.example');
  await page.click('#dlg-settings button[value=save]');
  await page.waitForFunction(() => localStorage.getItem('bnss94.settings')); // dialog 'close' fires async
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bnss94.settings')));
  assert.strictEqual(stored.officerName, 'SI Synthetic Officer');

  await page.setInputFiles('#file-txn', path.join(ROOT, 'samples/sample_ncrp_export.xlsx'));
  await page.setInputFiles('#file-nodal', path.join(ROOT, 'samples/sample_nodal_officers.xlsx'));
  await page.waitForSelector('#step-mapping:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#nodal-map select').length > 0);
  const mapped = await page.$$eval('#txn-map select', (s) => s.filter((x) => x.value).length);
  assert.strictEqual(mapped, 9, 'all 9 transaction fields auto-mapped');

  await page.click('#btn-analyse');
  await page.waitForSelector('#step-results:not(.hidden)');
  const rows = await page.$$eval('#results tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim())));
  assert.strictEqual(rows.length, 10, '10 Layer 1 accounts');
  assert.strictEqual(rows[0][2], '000112233445566');
  assert.strictEqual(rows[0][6], '3');
  assert.strictEqual(rows[0][8], '83,000.00');
  const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('bnss94.txnMapping')));
  assert.strictEqual(remembered.account, 'Account No./ (Wallet /PG/PA) Id');

  // Filter + sort sanity
  await page.check('#f-repeated');
  assert.strictEqual(await page.$$eval('#results tbody tr', (t) => t.length), 4);
  await page.uncheck('#f-repeated');
  await page.click('#results th[data-key=disputedPaise]');
  assert.strictEqual(await page.$eval('#results tbody tr td:nth-child(3)', (td) => td.textContent), '000112233445566');

  // Unmatched bank shown
  const unmatched = await page.$$eval('#banks tr.unmatched', (t) => t.map((r) => r.textContent));
  assert.strictEqual(unmatched.length, 1);
  assert.ok(unmatched[0].includes('Nowhere Rural Bank'));
  await page.screenshot({ path: path.join(OUT, 'results.png'), fullPage: true });

  // Generate
  await page.fill('#g-caseref', 'CCPS/TST/2026/001');
  const emails = await page.$$eval('#emails tr', (t) => t.slice(1).map((r) => [...r.cells].map((c) => c.textContent)));
  assert.strictEqual(emails.length, 7);
  assert.ok(emails.some((r) => r[0] === 'Sample Federal Bank' && r[1] === 'le.cell@samplefederal.example; fraud@samplefederal.example'
    && r[2] === 'Sec94_BNSS_CCPS_TST_2026_001_Sample_Federal_Bank.docx'));

  // Preview renders the table
  await page.click('#emails tr:nth-child(3) button:has-text("Preview")');
  assert.ok(await page.$eval('#preview-body', (p) => p.querySelector('table') && p.textContent.includes('SECTION 94')));
  await page.screenshot({ path: path.join(OUT, 'preview.png') });
  await page.click('#preview-close');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-zip')]);
  const zipPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(zipPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const docs = files.filter((n) => n.endsWith('.docx'));
  assert.strictEqual(docs.length, 7, '7 notices');
  for (const d of docs) {
    const buf = await zip.file(d).async('nodebuffer');
    fs.writeFileSync(path.join(OUT, path.basename(d)), buf);
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
    assert.ok(xml.includes('SI Synthetic Officer'), d + ' has officer name');
    assert.ok(!xml.includes('{{'), d + ' has no unfilled placeholders');
  }
  const xbuf = await zip.file('BNSS94_Summary.xlsx').async('nodebuffer');
  fs.writeFileSync(path.join(OUT, 'BNSS94_Summary.xlsx'), xbuf);
  const wb = XLSX.read(xbuf);
  assert.ok(wb.SheetNames.includes('Email Mapping'));
  assert.strictEqual(wb.Sheets['Layer1 Analysis'].C2.v, '000112233445566');

  // Template edit is saved
  await page.click('#btn-template');
  await page.fill('#tpl-text', '[center]**TEST {{bank_name}}**\n{{accounts_table}}');
  await page.click('#tpl-save');
  assert.ok((await page.evaluate(() => localStorage.getItem('bnss94.template'))).includes('TEST {{bank_name}}'));

  assert.deepStrictEqual(network, [], 'no network requests');
  assert.deepStrictEqual(errors, [], 'no console errors');
  await browser.close();
  console.log('e2e ok — ' + docs.length + ' notices, outputs in ' + path.relative(ROOT, OUT));
})().catch((e) => { console.error('e2e FAILED:', e); process.exit(1); });
