#!/usr/bin/env node
/*
 * Runs the analysis logic on the synthetic samples and checks the results.
 * Uses only the vendored libraries — no npm install needed.
 *
 *   node tests/run-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const XLSX = require(path.join(ROOT, 'vendor/xlsx.full.min.js'));
const JSZip = require(path.join(ROOT, 'vendor/jszip.min.js'));
const docx = new Function(fs.readFileSync(path.join(ROOT, 'vendor/docx.iife.js'), 'utf8') + '\nreturn docx;')();
const B = require(path.join(ROOT, 'js/analysis.js'));
const T = require(path.join(ROOT, 'js/template.js'));
const O = require(path.join(ROOT, 'js/outputs.js')).create({ docx, XLSX, JSZip });

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
  });
}

const section = (name) => pending.push(async () => console.log('\n' + name));

function readAoa(file) {
  const wb = XLSX.read(fs.readFileSync(file), { cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
}

// ---------------------------------------------------------------- fixtures
const txnTable = B.tableFromAoa(readAoa(path.join(ROOT, 'samples/sample_ncrp_export.xlsx')), B.TXN_FIELDS);
const txnMap = B.guessMapping(txnTable.headers, B.TXN_FIELDS);
const result = B.analyse(txnTable.rows, txnMap);
const byAcc = Object.fromEntries(result.accounts.map((a) => [a.account, a]));
const nodalTable = B.tableFromAoa(readAoa(path.join(ROOT, 'samples/sample_nodal_officers.xlsx')), B.NODAL_FIELDS);
const nodalMap = B.guessMapping(nodalTable.headers, B.NODAL_FIELDS);
const directory = B.buildNodalDirectory(nodalTable.rows, nodalMap);
const grouped = B.groupByBank(result.accounts, directory);
const groupOf = (acc) => grouped.groups.find((g) => g.accounts.some((a) => a.account === acc));

console.log('BNSS94 Notice Tool — tests');

// ------------------------------------------------------------ normalisation
section('Normalisation');
test('account numbers stay strings with leading zeros', () => {
  assert.strictEqual(B.normId('000123').value, '000123');
  assert.strictEqual(B.normId("'000123").value, '000123');
  assert.strictEqual(B.normId(' 5010 0012 3456 78 ').value, '50100012345678');
  assert.strictEqual(B.normId('‘ 99​88 ').value, '9988');
  assert.strictEqual(B.normId(7766554433).value, '7766554433');
});
test('unsafe numeric / scientific account numbers are flagged', () => {
  assert.ok(B.normId(12345678901234567890).warning);
  assert.ok(B.normId('1.23457E+15').warning);
  assert.strictEqual(B.normId('123456789012').warning, null);
});
test('amounts parse to integer paise', () => {
  assert.strictEqual(B.parseAmountPaise('₹ 1,23,456.50'), 12345650);
  assert.strictEqual(B.parseAmountPaise('Rs. 500/-'), 50000);
  assert.strictEqual(B.parseAmountPaise(9999.5), 999950);
  assert.strictEqual(B.parseAmountPaise(''), 0);
  assert.strictEqual(B.formatINR(12345650), '1,23,456.50');
  assert.strictEqual(B.formatINR(50), '0.50');
});
test('layer values parse from mixed formats', () => {
  assert.strictEqual(B.parseLayer('Layer 1'), 1);
  assert.strictEqual(B.parseLayer('Layer-2'), 2);
  assert.strictEqual(B.parseLayer(3), 3);
  assert.ok(isNaN(B.parseLayer('')));
});

// ----------------------------------------------------------- header mapping
section('Column mapping');
test('header row detected below the title rows', () => assert.strictEqual(txnTable.headerRow, 3));
test('NCRP headers auto-map to every field', () => {
  assert.deepStrictEqual(txnMap, {
    ack: 'Acknowledgement No.', account: 'Account No./ (Wallet /PG/PA) Id', bank: 'Bank/FIs', ifsc: 'Ifsc Code',
    layer: 'Layer', txnId: 'Transaction Id / UTR Number', txnDate: 'Transaction Date',
    amount: 'Transaction Amount', disputed: 'Disputed Amount',
  });
});
test('remembered mapping wins over guesses when the header exists', () => {
  const m = B.guessMapping(txnTable.headers, B.TXN_FIELDS, { amount: 'Disputed Amount', bank: 'Missing Header' });
  assert.strictEqual(m.amount, 'Disputed Amount');
  assert.strictEqual(m.disputed, '', 'header already used must not be reused');
  assert.strictEqual(m.bank, 'Bank/FIs');
});
test('nodal sheet headers auto-map', () => {
  assert.strictEqual(nodalMap.bank, 'Bank Name');
  assert.strictEqual(nodalMap.ifscPrefix, 'IFSC Prefix');
  assert.strictEqual(nodalMap.email, 'Email ID');
  assert.strictEqual(nodalMap.email2, 'Alternate Email');
});

// --------------------------------------------------------------- analysis
section('Layer 1 analysis');
test('reads all rows, 8 Ack nos, 3 layers', () => {
  assert.strictEqual(result.stats.totalRows, 39);
  assert.strictEqual(result.stats.ackCount, 8);
  assert.deepStrictEqual(Object.keys(result.stats.layers).sort(), ['1', '2', '3']);
});
test('only Layer 1 rows are analysed', () => {
  assert.strictEqual(result.stats.layerRows, 17);
  assert.strictEqual(result.accounts.length, 10);
  // Layer 2/3-only accounts must not appear
  ['221100998877', '443322110099', '909090909090', '353535353535'].forEach((a) => assert.ok(!byAcc[a], a));
});
test('Layer 2 rows of a Layer 1 account do not inflate its totals', () => {
  assert.strictEqual(byAcc['7766554433'].disputedPaise, 7200000); // excludes the 5,000 at layer 2
  assert.strictEqual(byAcc['7766554433'].txnCount, 2);
});
test('repeat counts across Ack nos', () => {
  assert.strictEqual(byAcc['000112233445566'].ackCount, 3);
  assert.deepStrictEqual(byAcc['000112233445566'].acks, ['99900000000101', '99900000000102', '99900000000105']);
  assert.strictEqual(byAcc['50100012345678'].ackCount, 2, 'spaces / apostrophe variants merge');
  assert.strictEqual(byAcc['7766554433'].ackCount, 2, 'numeric and text cells merge');
  assert.strictEqual(byAcc['345678901234'].ackCount, 2);
  assert.strictEqual(byAcc['123400009999'].ackCount, 1);
  assert.strictEqual(result.stats.repeatedCount, 4);
});
test('disputed totals per account', () => {
  const exp = {
    '000112233445566': 83000, '7766554433': 72000, '50100012345678': 24999.5, '345678901234': 10000,
    '123400009999': 50000, '990011223344': 45000, '889900112233': 10000, '000098765432': 5000,
    '556677889900': 2500, '667788990011': 1200,
  };
  Object.entries(exp).forEach(([acc, rs]) => assert.strictEqual(B.paiseToNumber(byAcc[acc].disputedPaise), rs, acc));
  assert.strictEqual(B.paiseToNumber(result.stats.disputedPaise), 303699.5);
});
test('exact duplicate rows are counted once', () => {
  assert.strictEqual(result.stats.duplicateRows, 1);
  assert.strictEqual(byAcc['123400009999'].txnCount, 2);
});
test('default ranking: repeat count, then disputed amount', () => {
  assert.deepStrictEqual(result.accounts.map((a) => a.account), [
    '000112233445566', '7766554433', '50100012345678', '345678901234',
    '123400009999', '990011223344', '889900112233', '000098765432', '556677889900', '667788990011',
  ]);
});
test('missing Layer column treats every row as Layer 1 with a warning', () => {
  const r = B.analyse(txnTable.rows, Object.assign({}, txnMap, { layer: '' }));
  assert.ok(r.accounts.length > 10);
  assert.ok(r.warnings.some((w) => /Layer/.test(w)));
});

// ------------------------------------------------------------ bank matching
section('Bank matching & grouping');
test('bank-name similarity', () => {
  assert.ok(B.bankSimilarity('HDFC BANK LTD.', 'HDFC Bank') >= B.BANK_MATCH_THRESHOLD);
  assert.ok(B.bankSimilarity('SBI', 'State Bank of India') >= B.BANK_MATCH_THRESHOLD);
  assert.ok(B.bankSimilarity('Bank of India', 'Bank of Baroda') < B.BANK_MATCH_THRESHOLD);
  assert.ok(B.bankSimilarity('Bank of India', 'State Bank of India') < B.BANK_MATCH_THRESHOLD);
  assert.ok(B.bankSimilarity('Punjab National Bank', 'Punjab & Sind Bank') < B.BANK_MATCH_THRESHOLD);
});
test('IFSC prefix is used before the name', () => {
  const m = B.matchBank('Some Garbled Name', 'EXNB0001234', directory);
  assert.strictEqual(m.method, 'ifsc');
  assert.strictEqual(m.entry.bank, 'Example National Bank');
});
test('fuzzy name match when IFSC is missing or unknown', () => {
  assert.strictEqual(B.matchBank('Demo Bank', '', directory).entry.bank, 'Demo Bank Limited');
  assert.strictEqual(B.matchBank('Mock City Bank Ltd.', '', directory).method, 'name');
  assert.strictEqual(B.matchBank('TESTPUR GRAMIN BANK', 'TSTG0000101', directory).method, 'name');
});
test('bank grouping', () => {
  assert.strictEqual(grouped.groups.length, 7);
  assert.deepStrictEqual(groupOf('000112233445566').accounts.map((a) => a.account), ['000112233445566', '000098765432']);
  assert.deepStrictEqual(groupOf('123400009999').accounts.map((a) => a.account), ['123400009999', '990011223344']);
  assert.strictEqual(groupOf('7766554433').bankName, 'Sample Federal Bank');
  assert.deepStrictEqual(groupOf('7766554433').emails, ['le.cell@samplefederal.example', 'fraud@samplefederal.example']);
  assert.deepStrictEqual(groupOf('000112233445566').acks, ['99900000000101', '99900000000102', '99900000000103', '99900000000105']);
});
test('unmatched bank detection', () => {
  assert.strictEqual(grouped.unmatched.length, 1);
  assert.strictEqual(grouped.unmatched[0].bankName, 'Nowhere Rural Bank');
  assert.strictEqual(grouped.unmatched[0].entry, null);
  assert.strictEqual(grouped.groups[0].bankName, 'Nowhere Rural Bank', 'unmatched banks listed first');
});
test('manual override resolves an unmatched bank', () => {
  const overrides = { [B.normBankName('Nowhere Rural Bank')]: directory.find((d) => d.bank === 'Demo Bank Limited').id };
  const g = B.groupByBank(result.accounts, directory, overrides);
  assert.strictEqual(g.unmatched.length, 0);
  assert.strictEqual(g.groups.find((x) => x.bankName === 'Demo Bank Limited').accounts.length, 2);
});

// ---------------------------------------------------------------- template
section('Template & outputs');
test('placeholders fill and the table block is produced', () => {
  const g = groupOf('000112233445566');
  const blocks = T.toBlocks(T.DEFAULT_TEMPLATE, T.valuesFor(g, { officerName: 'SI Test', station: 'Cyber Cell', caseRef: 'REF/1' }), g.accounts);
  const text = blocks.filter((b) => b.type === 'para').map((b) => b.runs.map((r) => r.text).join('')).join('\n');
  assert.ok(!/\{\{/.test(text), 'no placeholders left');
  assert.ok(text.includes('Example National Bank'));
  assert.ok(text.includes('99900000000101, 99900000000102, 99900000000103, 99900000000105'));
  const table = blocks.find((b) => b.type === 'table');
  assert.strictEqual(table.rows.length, 2);
  assert.strictEqual(table.rows[0][1], '000112233445566');
  assert.deepStrictEqual(B.unknownPlaceholders('{{date}} {{foo}}'), ['foo']);
});
test('file names are safe and unique', () => {
  const gs = O.assignFileNames([{ bankName: 'A/B Bank' }, { bankName: 'A B Bank' }], { caseRef: 'Cr.No 12/2026' });
  assert.strictEqual(gs[0].fileName, 'Sec94_BNSS_Cr.No_12_2026_A_B_Bank.docx');
  assert.strictEqual(gs[1].fileName, 'Sec94_BNSS_Cr.No_12_2026_A_B_Bank_2.docx');
});

const settings = { officerName: 'SI Synthetic Officer', designation: 'Sub-Inspector', station: 'Cyber Crime Police Station, Testpur',
  caseRef: 'CCPS/TST/2026/001', phone: '0000000000', officerEmail: 'cyber@police.example', noticeDate: '04-11-2026' };

test('ZIP contains one .docx per bank, the Excel summary and the e-mail list', async () => {
  const accounts = result.accounts.map((a) => Object.assign({}, a, { selected: true, match: B.matchBank(a.bank, a.ifsc, directory) }));
  O.assignFileNames(grouped.groups, settings);
  const ctx = { analysis: result, accounts, groups: grouped.groups, unmatched: grouped.unmatched, settings };
  const zipBuf = await O.bundleZip(ctx, T.DEFAULT_TEMPLATE);
  const outDir = path.join(ROOT, 'output', 'test-run');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bundle.zip'), zipBuf);

  const zip = await JSZip.loadAsync(zipBuf);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  const docs = names.filter((n) => n.endsWith('.docx'));
  assert.strictEqual(docs.length, 7);
  assert.ok(names.includes('BNSS94_Summary.xlsx'));
  assert.ok(names.includes('Email_List.csv'));

  // Each .docx is a valid zip with the account numbers in document.xml
  for (const d of docs) {
    const buf = await zip.file(d).async('nodebuffer');
    fs.writeFileSync(path.join(outDir, path.basename(d)), buf);
    const inner = await JSZip.loadAsync(buf);
    const xml = await inner.file('word/document.xml').async('string');
    assert.ok(xml.includes('Section 94') || xml.includes('SECTION 94'), d);
    assert.ok(!xml.includes('{{'), d + ' has unfilled placeholders');
  }
  const exnb = await JSZip.loadAsync(await zip.file('Notices/Sec94_BNSS_CCPS_TST_2026_001_Example_National_Bank.docx').async('nodebuffer'));
  const exml = await exnb.file('word/document.xml').async('string');
  assert.ok(exml.includes('000112233445566') && exml.includes('000098765432'));
  assert.ok(exml.includes('<w:tbl>'), 'accounts table present');

  // Excel summary: identifiers are text cells with leading zeros intact
  const xbuf = await zip.file('BNSS94_Summary.xlsx').async('nodebuffer');
  fs.writeFileSync(path.join(outDir, 'BNSS94_Summary.xlsx'), xbuf);
  const wb = XLSX.read(xbuf);
  assert.deepStrictEqual(wb.SheetNames, ['Summary', 'Layer1 Analysis', 'Bank-wise Accounts', 'Email Mapping', 'Layer1 Transactions', 'Unmatched Banks']);
  const l1 = wb.Sheets['Layer1 Analysis'];
  assert.strictEqual(l1.C2.t, 's');
  assert.strictEqual(l1.C2.v, '000112233445566');
  assert.strictEqual(l1.J2.v, 83000);
  const em = XLSX.utils.sheet_to_json(wb.Sheets['Email Mapping']);
  assert.strictEqual(em.length, 7);
  const sfb = em.find((r) => r.Bank === 'Sample Federal Bank');
  assert.strictEqual(sfb['Nodal E-mail(s)'], 'le.cell@samplefederal.example; fraud@samplefederal.example');
  assert.strictEqual(sfb.Attachment, 'Sec94_BNSS_CCPS_TST_2026_001_Sample_Federal_Bank.docx');

  const csv = await zip.file('Email_List.csv').async('string');
  assert.ok(csv.includes('Nowhere Rural Bank,NOT FOUND'));
});

(async () => {
  for (const t of pending) await t();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
