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
const M = require(path.join(ROOT, 'js/mail.js'));
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
    amount: 'Transaction Amount', disputed: 'Disputed Amount', holdAmount: 'Put on Hold Amount',
    phone: 'Suspect Mobile No.', url: 'Suspect URL', socialId: 'Suspect Social Media / UPI ID',
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
  assert.strictEqual(nodalMap.category, 'Category');
  assert.strictEqual(nodalMap.domains, 'Domains / UPI Handles');
});

// --------------------------------------------------------------- analysis
section('Layer 1 analysis');
test('reads all rows, 8 Ack nos, 3 layers', () => {
  assert.strictEqual(result.stats.totalRows, 39);
  assert.strictEqual(result.stats.ackCount, 8);
  assert.deepStrictEqual(Object.keys(result.stats.layers).sort(), ['1', '2', '3']);
});
test('only Layer 1 rows are analysed', () => {
  assert.strictEqual(result.stats.layerRows, 16, 'unique Layer 1 rows (one exact duplicate)');
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

// ------------------------------------------------- loss, hold, identifiers
section('Total loss, put on hold & identifiers');
test('per-Ack total loss (Layer 1 disputed) and put-on-hold amounts', () => {
  const ack = (n) => result.ackSummary.find((a) => a.ack === '999000000001' + n);
  assert.strictEqual(result.ackSummary.length, 8);
  assert.strictEqual(B.paiseToNumber(ack('01').lossPaise), 32000); // 25,000 + 7,000 at Layer 1
  assert.strictEqual(B.paiseToNumber(ack('01').holdPaise), 7000);
  assert.strictEqual(B.paiseToNumber(ack('04').holdPaise), 25000, 'hold counted at any layer');
  assert.deepStrictEqual(ack('01').layers, [1, 2, 3]);
  assert.strictEqual(B.paiseToNumber(result.stats.totalLossPaise), 303699.5);
  assert.strictEqual(B.paiseToNumber(result.stats.totalHoldPaise), 61000);
});
test('identifier classification', () => {
  const c = (v, h) => B.classifyIdentifier(v, h);
  assert.deepStrictEqual([c('+91 98765-43210', 'phone').type, c('+91 98765-43210', 'phone').value], ['phone', '9876543210']);
  assert.strictEqual(c('09876543210').value, '9876543210');
  assert.ok(c('12345', 'phone').warning);
  assert.strictEqual(c('www.Fraud-Site.example/x').domain, 'fraud-site.example');
  assert.strictEqual(c('https://samplegram.example/u', 'social').type, 'social');
  assert.strictEqual(c('@Some_Handle', 'social').value, 'some_handle');
  assert.strictEqual(c('payme@okfict').type, 'upi');
  assert.strictEqual(c('Cheat@Mail.example').type, 'email');
  assert.strictEqual(c('NA', 'phone'), null);
});
const idents = B.extractIdentifiers(txnTable.rows, txnMap);
const identOf = (v) => idents.find((i) => i.value === v);
test('identifiers extracted from the export, merged across Ack nos', () => {
  assert.strictEqual(idents.length, 9);
  assert.deepStrictEqual(identOf('9000000001').acks, ['99900000000101', '99900000000105']);
  assert.ok(identOf('9000000002'), '+91 prefix normalised');
  assert.ok(identOf('9000000003') && identOf('9000000004'), 'comma-separated cell split');
  assert.strictEqual(idents.filter((i) => i.type === 'phone').length, 4);
});
test('directory categories and domain / UPI-handle matching', () => {
  const byName = (n) => directory.find((d) => d.bank === n);
  assert.strictEqual(byName('Example Telecom Ltd').category, 'telecom');
  assert.strictEqual(byName('DemoChat Messenger').category, 'platform');
  assert.strictEqual(byName('Fictional Payments Bank').category, 'payment');
  assert.strictEqual(B.matchIdentifier(identOf('https://samplegram.example/fake.investment.tips'), directory).entry.bank, 'SampleGram (Sample Social Inc.)');
  assert.strictEqual(B.matchIdentifier(identOf('scammer99@okfict'), directory).entry.bank, 'Fictional Payments Bank');
  assert.strictEqual(B.matchIdentifier(identOf('9000000001'), directory).entry, null, 'phones need an operator');
  assert.strictEqual(B.matchIdentifier(identOf('9000000001'), directory, { 'phone:9000000001': 'Example Telecom Ltd' }).method, 'manual');
  assert.strictEqual(B.matchBank('SampleGram', '', directory).entry, null, 'platforms never match bank accounts');
});
test('identifier grouping by recipient, unassigned flagged', () => {
  const g = B.groupIdentifiers(idents, directory, { 'phone:9000000001': 'Example Telecom Ltd', 'phone:9000000002': 'Example Telecom Ltd' });
  const tel = g.find((x) => x.bankName === 'Example Telecom Ltd');
  assert.strictEqual(tel.items.length, 2);
  assert.strictEqual(tel.kind, 'telecom');
  const unassigned = g.filter((x) => !x.entry);
  assert.deepStrictEqual(unassigned.map((x) => x.key).sort(), ['U:phone', 'U:social', 'U:url']);
});
test('mandatory-field prompts for a case', () => {
  const none = B.checkCase({}, {}, null, []).map((x) => x.field);
  ['firNo', 'firDate', 'policeStation', 'sections', 'firCopy', 'export', 'officer', 'officerEmail'].forEach((f) => assert.ok(none.includes(f), f));
  const full = B.checkCase({ firNo: '1/2026', firDate: '01-01-2026', policeStation: 'PS', sections: '318 BNS', hasFirCopy: true, hasExport: true },
    { officerName: 'A', designation: 'B', officerEmail: 'a@b.example' }, result, grouped.groups);
  assert.deepStrictEqual(full.filter((x) => x.level === 'missing').map((x) => x.field), ['recipient:U:NOWHERE RURAL BANK']);
  assert.ok(full.some((x) => x.field === 'rows.ifsc' && x.level === 'warning'));
});

// ------------------------------------------------------------------ e-mail
section('E-mail drafts & replies');
test('.eml draft round-trips with attachments intact', () => {
  const bin = new Uint8Array(5000).map((_, i) => (i * 31) % 256);
  const eml = M.buildEml({ fromName: 'SI Tést', fromEmail: 'cyber@police.example', to: ['a@x.example'], subject: 'Notice – Bank [Ref: N94-123.2026-01]',
    text: 'Sir/Madam,\nबैंक ₹', attachments: [{ name: 'n.docx', type: 'application/octet-stream', data: bin }, { name: 'FIR.pdf', type: 'application/pdf', data: new Uint8Array([1, 2, 3]) }] });
  assert.ok(/^X-Unsent: 1$/m.test(eml), 'opens as a draft in Outlook');
  const p = M.parseEml(eml);
  assert.strictEqual(p.subject, 'Notice – Bank [Ref: N94-123.2026-01]');
  assert.strictEqual(p.text.replace(/\r/g, ''), 'Sir/Madam,\nबैंक ₹');
  assert.deepStrictEqual(p.attachments.map((a) => a.name), ['n.docx', 'FIR.pdf']);
  assert.ok(Buffer.from(p.attachments[0].data).equals(Buffer.from(bin)));
});
test('reply .eml from another mail client: quoted-printable, RFC 2231 file name, nested multipart', () => {
  const reply = [
    'From: "Nodal Officer" <le.cell@samplefederal.example>', 'To: cyber@police.example',
    'Subject: =?UTF-8?Q?RE:_Notice_u/s_94_BNSS_=E2=80=93_Sample_Federal_Bank_[Ref:_N94-123.2026-03]?=',
    'Date: Thu, 05 Nov 2026 10:00:00 +0530', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="OUTER"', '',
    '--OUTER', 'Content-Type: multipart/alternative; boundary="INNER"', '',
    '--INNER', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Please find the statement attached =E2=80=93 regards.=', '', '--INNER', 'Content-Type: text/html; charset=utf-8', '', '<p>Please find</p>', '--INNER--', '',
    '--OUTER', 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', "Content-Disposition: attachment; filename*=UTF-8''Statement%20%E2%82%B9.pdf", '',
    Buffer.from('%PDF-fake').toString('base64'), '--OUTER--', 'epilogue text', ''
  ].join('\r\n');
  const p = M.parseEml(Buffer.from(reply, 'latin1'));
  assert.strictEqual(p.subject, 'RE: Notice u/s 94 BNSS – Sample Federal Bank [Ref: N94-123.2026-03]');
  assert.strictEqual(p.fromEmail, 'le.cell@samplefederal.example');
  assert.strictEqual(p.text, 'Please find the statement attached – regards.');
  assert.strictEqual(p.attachments.length, 1);
  assert.strictEqual(p.attachments[0].name, 'Statement ₹.pdf');
  assert.strictEqual(Buffer.from(p.attachments[0].data).toString(), '%PDF-fake');
  const notices = [{ ref: 'N94-123.2026-01', emails: ['nodal@examplenational.example'] }, { ref: 'N94-123.2026-03', emails: ['le.cell@samplefederal.example'] }];
  assert.strictEqual(M.matchReply(p, notices).notice.ref, 'N94-123.2026-03');
  assert.strictEqual(M.matchReply(p, notices).method, 'ref');
});
test('reply matching falls back to the sender address, and flags ambiguity', () => {
  const n = [{ ref: 'A', emails: ['x@bank.example'], status: 'sent' }, { ref: 'B', emails: ['y@other.example'], status: 'sent' }, { ref: 'C', emails: ['y@other.example'], status: 'sent' }];
  assert.strictEqual(M.matchReply({ subject: 'Re: your letter', fromEmail: 'x@bank.example' }, n).notice.ref, 'A');
  assert.strictEqual(M.matchReply({ subject: 'Re: info', fromEmail: 'other.officer@bank.example' }, n).method, 'sender', 'same domain');
  assert.strictEqual(M.matchReply({ subject: 'Re', fromEmail: 'y@other.example' }, n).method, 'ambiguous');
  assert.strictEqual(M.matchReply({ subject: 'hi', fromEmail: 'z@none.example' }, n).method, 'none');
  assert.strictEqual(M.noticeRef('Cr.No 45/2026', 3), 'N94-CR.NO.45.2026-03');
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

test('requested documents depend on recipient category', () => {
  assert.deepStrictEqual(T.defaultRequested('bank'), ['statement', 'kyc', 'aof', 'photos', 'aadhaar', 'pan']);
  assert.deepStrictEqual(T.defaultRequested('telecom'), ['kyc', 'photos', 'aadhaar', 'cdr', 'sdr', 'ipdr']);
  const tel = { kind: 'telecom', bankName: 'Example Telecom Ltd', acks: ['1'], items: [identOf('9000000001')], accounts: [] };
  const blocks = T.toBlocks(T.DEFAULT_TEMPLATE, T.valuesFor(tel, {}, { firNo: '123/2026', periodFrom: '01-02-2026', periodTo: '31-03-2026' }), tel);
  const text = blocks.filter((b) => b.type === 'para').map((b) => b.runs.map((r) => r.text).join('')).join('\n');
  assert.ok(text.includes('Call Detail Records (CDR) with cell-ID / tower location for the period 01-02-2026 to 31-03-2026.'));
  assert.ok(text.includes('1 mobile number serviced by your network'));
  assert.ok(text.includes('Request for production of KYC details, Photographs, Aadhaar, CDR, SDR / CAF, IPDR under'));
  const table = blocks.find((b) => b.type === 'table');
  assert.deepStrictEqual(table.headers, T.ID_TABLE_HEADERS);
  const noPeriod = T.toBlocks('{{requested_items}}', T.valuesFor(tel, {}, {}), tel).map((b) => b.runs[0].text);
  assert.ok(noPeriod.includes('5. Call Detail Records (CDR) with cell-ID / tower location.') || noPeriod.some((t) => /CDR\) with cell-ID \/ tower location\.$/.test(t)));
});

const settings = { officerName: 'SI Synthetic Officer', designation: 'Sub-Inspector', station: 'Cyber Crime Police Station, Testpur',
  caseRef: '123/2026', phone: '0000000000', officerEmail: 'cyber@police.example', noticeDate: '04-11-2026', replyDays: 7 };
const caseInfo = { firNo: '123/2026', firDate: '01-03-2026', policeStation: 'Cyber Crime PS, Testpur', sections: '318(4) BNS; 66D IT Act',
  periodFrom: '01-02-2026', periodTo: '31-03-2026', totalLossPaise: result.stats.totalLossPaise, holdPaise: result.stats.totalHoldPaise };

/** Same merge the UI does: bank groups + identifier groups, one notice per nodal entry. */
function recipients(assignments) {
  const idG = B.groupIdentifiers(idents, directory, assignments);
  const byKey = {}, list = [];
  grouped.groups.concat(idG).forEach((g) => {
    const k = g.entry ? g.entry.id : 'X' + g.key;
    if (!byKey[k]) { byKey[k] = Object.assign({}, g, { accounts: (g.accounts || []).slice(), items: (g.items || []).slice(), acks: g.acks.slice() }); list.push(byKey[k]); }
    else { byKey[k].items = byKey[k].items.concat(g.items || []); g.acks.forEach((a) => byKey[k].acks.includes(a) || byKey[k].acks.push(a)); }
  });
  return list.filter((g) => g.entry || g.accounts.length);
}

test('ZIP: one .docx per recipient, e-mail drafts with FIR copy, Excel summary, e-mail list', async () => {
  const groups = recipients({ 'phone:9000000001': 'Example Telecom Ltd', 'phone:9000000002': 'Example Telecom Ltd', 'phone:9000000003': 'Demo Mobile Networks', 'phone:9000000004': 'Demo Mobile Networks' });
  O.assignFileNames(groups, settings);
  groups.forEach((g, i) => { g.noticeRef = M.noticeRef(caseInfo.firNo, i + 1); });
  const accounts = result.accounts.map((a) => Object.assign({}, a, { selected: true, match: B.matchBank(a.bank, a.ifsc, directory) }));
  idents.forEach((i) => { i.selected = true; i.match = B.matchIdentifier(i, directory, {}); });
  const fir = fs.readFileSync(path.join(ROOT, 'samples/sample_fir_copy.pdf'));
  const ctx = { analysis: result, accounts, groups, unmatched: groups.filter((g) => !g.emails.length), settings, caseInfo, identifiers: idents,
    firCopy: { name: 'FIR_Copy_123_2026.pdf', type: 'application/pdf', data: new Uint8Array(fir) } };
  const zipBuf = await O.bundleZip(ctx, { notice: T.DEFAULT_TEMPLATE, subject: T.DEFAULT_EMAIL_SUBJECT, body: T.DEFAULT_EMAIL_BODY });
  const outDir = path.join(ROOT, 'output', 'test-run');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bundle.zip'), zipBuf);

  const zip = await JSZip.loadAsync(zipBuf);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  const docs = names.filter((n) => n.endsWith('.docx'));
  const emls = names.filter((n) => n.endsWith('.eml'));
  assert.strictEqual(docs.length, 11, '7 banks/payment (UPI ID merged into the payment bank) + 2 telecom + 2 platforms');
  assert.strictEqual(emls.length, 10, 'no draft for the bank without an e-mail ID');
  ['BNSS94_Summary.xlsx', 'Email_List.csv', 'FIR_Copy_123_2026.pdf'].forEach((f) => assert.ok(names.includes(f), f));

  for (const d of docs) {
    const buf = await zip.file(d).async('nodebuffer');
    fs.writeFileSync(path.join(outDir, path.basename(d)), buf);
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
    assert.ok(xml.includes('SECTION 94'), d);
    assert.ok(!xml.includes('{{'), d + ' has unfilled placeholders');
    assert.ok(xml.includes('FIR No. 123/2026 dated 01-03-2026'), d + ' FIR reference');
  }
  const docXml = async (f) => (await JSZip.loadAsync(await zip.file('Notices/' + f).async('nodebuffer'))).file('word/document.xml').async('string');
  const exml = await docXml('Sec94_BNSS_123_2026_Example_National_Bank.docx');
  assert.ok(exml.includes('000112233445566') && exml.includes('000098765432') && exml.includes('Account Opening Form'));
  const txml = await docXml('Sec94_BNSS_123_2026_Example_Telecom_Ltd.docx');
  assert.ok(txml.includes('9000000001') && txml.includes('Call Detail Records') && txml.includes('IPDR') && !txml.includes('Account Opening Form'));
  const pxml = await docXml('Sec94_BNSS_123_2026_Fictional_Payments_Bank.docx');
  assert.ok(pxml.includes('556677889900') && pxml.includes('scammer99@okfict'), 'account and UPI ID in one notice');
  assert.strictEqual((pxml.match(/<w:tbl>/g) || []).length, 2, 'two tables: accounts and identifiers');

  // E-mail draft: addressed to the nodal officer, notice + FIR copy attached, ref in subject
  const emlText = await zip.file('Email_Drafts/Sec94_BNSS_123_2026_Sample_Federal_Bank.eml').async('string');
  fs.writeFileSync(path.join(outDir, 'Sample_Federal_Bank.eml'), emlText);
  const mail = M.parseEml(emlText);
  assert.deepStrictEqual(mail.to, ['le.cell@samplefederal.example', 'fraud@samplefederal.example']);
  const sfRef = groups.find((g) => g.bankName === 'Sample Federal Bank').noticeRef;
  assert.ok(mail.subject.includes('[Ref: ' + sfRef + ']'));
  assert.deepStrictEqual(mail.attachments.map((a) => a.name), ['Sec94_BNSS_123_2026_Sample_Federal_Bank.docx', 'FIR_Copy_123_2026.pdf']);
  assert.ok(Buffer.from(mail.attachments[1].data).equals(fir));

  // Excel summary
  const xbuf = await zip.file('BNSS94_Summary.xlsx').async('nodebuffer');
  fs.writeFileSync(path.join(outDir, 'BNSS94_Summary.xlsx'), xbuf);
  const wb = XLSX.read(xbuf);
  assert.deepStrictEqual(wb.SheetNames, ['Summary', 'Ack Summary', 'Layer1 Analysis', 'Bank-wise Accounts', 'Identifiers', 'Email Mapping', 'Layer1 Transactions', 'Unmatched']);
  const l1 = wb.Sheets['Layer1 Analysis'];
  assert.strictEqual(l1.C2.t, 's');
  assert.strictEqual(l1.C2.v, '000112233445566');
  assert.strictEqual(l1.J2.v, 83000);
  const em = XLSX.utils.sheet_to_json(wb.Sheets['Email Mapping']);
  assert.strictEqual(em.length, 11);
  const sfb = em.find((r) => r.Recipient === 'Sample Federal Bank');
  assert.strictEqual(sfb['Nodal E-mail(s)'], 'le.cell@samplefederal.example; fraud@samplefederal.example');
  assert.strictEqual(sfb.Attachment, 'Sec94_BNSS_123_2026_Sample_Federal_Bank.docx');
  assert.strictEqual(em.find((r) => r.Recipient === 'Example Telecom Ltd').Category, 'Telecom (TSP)');
  const ackSheet = XLSX.utils.sheet_to_json(wb.Sheets['Ack Summary']);
  assert.strictEqual(ackSheet.find((r) => r['Ack No'] === '99900000000104')['Put on Hold (₹)'], 25000);

  const csv = await zip.file('Email_List.csv').async('string');
  assert.ok(/Nowhere Rural Bank,N94-123\.2026-\d+,NOT FOUND/.test(csv));
});

(async () => {
  for (const t of pending) await t();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
