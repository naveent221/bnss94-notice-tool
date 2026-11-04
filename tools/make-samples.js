#!/usr/bin/env node
/*
 * Generates the SYNTHETIC sample files in samples/.
 * Every bank, account number, Ack number, UTR and e-mail here is invented.
 * Bank names are fictional and e-mails use the reserved ".example" domain.
 *
 *   node tools/make-samples.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');

const OUT = path.join(__dirname, '..', 'samples');
// The browser build of SheetJS has no fs access, so write buffers ourselves.
const save = (wb, name) => fs.writeFileSync(path.join(OUT, name), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
const ACK = (n) => '999000000001' + String(n).padStart(2, '0'); // 14-digit fake Ack nos

let utr = 900000000100;
const U = () => 'SYNUTR' + (utr++);
const d = (day, h) => new Date(2026, 2, day, h || 11, 15, 0);

// [ack, layer, account, bank, ifsc, date, amount, disputed]
const rows = [
  // ---------------- Layer 1 ----------------
  [ACK(1), 1, '000112233445566', 'EXAMPLE NATIONAL BANK LTD', 'EXNB0001234', d(2), 25000, 25000],
  [ACK(2), 1, '000112233445566', 'Example National Bank', 'EXNB0001234', d(3), 18000, 18000],
  [ACK(5), 1, "'000112233445566", 'Example National Bank', 'EXNB0001234', d(6), 40000, 40000],
  [ACK(3), 1, '5010 0012 3456 78', 'Demo Bank', '', '04/03/2026 10:15:22', 15000, 15000],
  [ACK(6), 1, "'50100012345678", 'Demo Bank', '', '07/03/2026 18:02:10', 10000, 9999.5],
  [ACK(4), 1, 7766554433, 'Sample Federal Bank', 'SMPF0000456', d(5), 60000, 60000],
  [ACK(7), 1, '7766554433', 'Sample Federal Bank', 'smpf0000456', d(8), 12000, 12000],
  [ACK(8), 1, '123400009999', 'Mock City Bank', 'MOCK0000777', d(9, 9), 30000, 30000],
  [ACK(8), 1, '123400009999', 'Mock City Bank', 'MOCK0000777', d(9, 10), 20000, 20000],
  [ACK(2), 1, '889900112233', 'Nowhere Rural Bank', 'NWRB0000001', d(3, 14), 10000, 10000],
  [ACK(3), 1, '000098765432', 'Example National Bank', 'EXNB0009999', d(4, 16), 5000, 5000],
  [ACK(1), 1, '345678901234', 'TESTPUR GRAMIN BANK', 'TSTG0000101', d(2, 13), 7000, 7000],
  [ACK(4), 1, '345678901234', 'Testpur Gramin Bank', 'TSTG0000101', d(5, 12), 3000, 3000],
  [ACK(5), 1, '556677889900', 'Fictional Payments Bank', 'FICT0000001', d(6, 20), 2500, 2500],
  [ACK(6), 1, '990011223344', 'Mock City Bank Ltd.', '', d(7, 8), 45000, 45000],
  [ACK(7), 1, '667788990011', 'Sample Federal Bank', 'SMPF0000999', d(8, 19), '₹ 1,200.00', '₹ 1,200.00'],
  // ---------------- Layer 2 ----------------
  [ACK(1), 2, '7766554433', 'Sample Federal Bank', 'SMPF0000456', d(2, 15), 5000, 5000],
  [ACK(1), 2, '221100998877', 'Demo Bank', 'DEMO0000011', d(2, 16), 12000, 12000],
  [ACK(2), 2, '443322110099', 'Mock City Bank', 'MOCK0000123', d(3, 17), 9000, 9000],
  [ACK(2), 2, '443322110099', 'Mock City Bank', 'MOCK0000123', d(3, 18), 6000, 6000],
  [ACK(3), 2, '665544332211', 'Example National Bank', 'EXNB0004321', d(4, 18), 8000, 8000],
  [ACK(4), 2, '112211221122', 'Fictional Payments Bank', 'FICT0000001', d(5, 14), 30000, 30000],
  [ACK(4), 2, '334433443344', 'Testpur Gramin Bank', 'TSTG0000202', d(5, 15), 20000, 20000],
  [ACK(5), 2, '556655665566', 'Sample Federal Bank', 'SMPF0000111', d(6, 21), 25000, 25000],
  [ACK(6), 2, '778877887788', 'Demo Bank', 'DEMO0000022', d(7, 9), 30000, 30000],
  [ACK(6), 2, '990099009900', 'Example National Bank', 'EXNB0001111', d(7, 10), 15000, 15000],
  [ACK(7), 2, '121212121212', 'Mock City Bank', 'MOCK0000456', d(8, 20), 10000, 10000],
  [ACK(8), 2, '343434343434', 'Demo Bank', 'DEMO0000033', d(9, 11), 25000, 25000],
  [ACK(8), 2, '565656565656', 'Sample Federal Bank', 'SMPF0000222', d(9, 12), 15000, 15000],
  [ACK(5), 2, '787878787878', 'Nowhere Rural Bank', 'NWRB0000002', d(6, 22), 9000, 9000],
  // ---------------- Layer 3 ----------------
  [ACK(1), 3, '909090909090', 'Mock City Bank', 'MOCK0000999', d(2, 18), 4000, 4000],
  [ACK(2), 3, '232323232323', 'Example National Bank', 'EXNB0002222', d(4, 9), 7000, 7000],
  [ACK(3), 3, '454545454545', 'Demo Bank', 'DEMO0000044', d(5, 9), 6000, 6000],
  [ACK(4), 3, '676767676767', 'Sample Federal Bank', 'SMPF0000333', d(6, 9), 20000, 20000],
  [ACK(5), 3, '898989898989', 'Fictional Payments Bank', 'FICT0000002', d(7, 11), 10000, 10000],
  [ACK(6), 3, '131313131313', 'Testpur Gramin Bank', 'TSTG0000303', d(8, 9), 12000, 12000],
  [ACK(7), 3, '242424242424', 'Mock City Bank', 'MOCK0000888', d(9, 9), 5000, 5000],
  [ACK(8), 3, '353535353535', 'Example National Bank', 'EXNB0003333', d(10, 9), 20000, 20000],
];

// Extra columns on some rows: put-on-hold amount and suspect identifiers.
// Key: [ack no, layer, account as written above]
const EXTRA = [
  [1, 1, '345678901234', { hold: 7000, phone: '9000000001' }],
  [2, 1, '889900112233', { phone: '+91 90000 00002' }],
  [3, 1, '000098765432', { phone: '9000000003, 9000000004' }],
  [4, 1, 7766554433, { url: 'https://samplegram.example/fake.investment.tips' }],
  [5, 1, "'000112233445566", { phone: '9000000001', social: 'scammer99@okfict' }],
  [6, 1, '990011223344', { url: 'www.fraud-invest-site.example/login' }],
  [7, 1, '667788990011', { social: '@quick.loans.help' }],
  [8, 1, '123400009999', { social: 'https://demochat.example/join/AbCdEf' }],
  [2, 2, '443322110099', { hold: 9000 }],
  [4, 2, '112211221122', { hold: 25000 }],
  [8, 3, '353535353535', { hold: 20000 }],
];
const extraFor = (r) => {
  const hit = EXTRA.find((e) => ACK(e[0]) === r[0] && e[1] === r[1] && e[2] === r[2]);
  if (hit) EXTRA.splice(EXTRA.indexOf(hit), 1); // first matching row only
  const x = hit ? hit[3] : {};
  return [x.hold || '', x.phone || '', x.url || '', x.social || ''];
};

const header = ['S No.', 'Acknowledgement No.', 'Layer', 'Account No./ (Wallet /PG/PA) Id', 'Transaction Id / UTR Number',
  'Bank/FIs', 'Ifsc Code', 'Transaction Date', 'Transaction Amount', 'Disputed Amount', 'Action Taken By Bank',
  'Put on Hold Amount', 'Suspect Mobile No.', 'Suspect URL', 'Suspect Social Media / UPI ID'];

const body = rows.map((r, i) => [i + 1, r[0], r[1] === 1 ? 'Layer 1' : r[1], r[2], U(), r[3], r[4], r[5], r[6], r[7], 'Money Transfer to'].concat(extraFor(r)));
// One exact duplicate row (same UTR) — the analysis must count it once.
const dupOf = body[7];
body.splice(9, 0, [body.length + 1].concat(dupOf.slice(1)));

const aoa = [['NCRP Transaction Details — SYNTHETIC SAMPLE, NOT REAL DATA'], [], header].concat(body);
const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: 'dd-mm-yyyy hh:mm' });
ws['!cols'] = [6, 18, 8, 26, 20, 28, 14, 18, 14, 14, 20, 12, 22, 40, 36].map((w) => ({ wch: w }));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
save(wb, 'sample_ncrp_export.xlsx');

const nodal = [
  ['Bank Name', 'Category', 'IFSC Prefix', 'Domains / UPI Handles', 'Nodal Officer', 'Email ID', 'Alternate Email', 'Address'],
  ['Example National Bank', 'Bank', 'EXNB', '', 'Nodal Officer (Synthetic)', 'nodal@examplenational.example', 'cybercell@examplenational.example', '1 Sample Road, Testpur'],
  ['Demo Bank Limited', 'Bank', 'DEMO', '', 'Nodal Officer (Synthetic)', 'nodal.officer@demobank.example', '', '2 Demo Street, Testpur'],
  ['Sample Federal Bank', 'Bank', 'SMPF', '', 'Nodal Officer (Synthetic)', 'le.cell@samplefederal.example; fraud@samplefederal.example', '', '3 Example Avenue, Testpur'],
  ['Testpur Gramin Bank', 'Bank', '', '', 'Nodal Officer (Synthetic)', 'nodal@testpurgramin.example', '', '4 Village Road, Testpur'],
  ['Mock City Bank', 'Bank', 'MOCK', '', 'Nodal Officer (Synthetic)', 'lea@mockcity.example', '', '5 Mock Lane, Testpur'],
  ['Fictional Payments Bank', 'Payment / Wallet', 'FICT', 'okfict, fictpay.example', 'Nodal Officer (Synthetic)', 'nodal@fictpay.example', 'grievance@fictpay.example', '6 Wallet Plaza, Testpur'],
  ['Unused Co-operative Bank', 'Bank', 'UNCB', '', 'Nodal Officer (Synthetic)', 'nodal@unusedcoop.example', '', '7 Unused Road, Testpur'],
  ['Example Telecom Ltd', 'Telecom', '', '', 'Nodal Officer (Synthetic)', 'nodal@exampletelecom.example', '', '8 Tower Road, Testpur'],
  ['Demo Mobile Networks', 'Telecom', '', '', 'Nodal Officer (Synthetic)', 'lea@demomobile.example', '', '9 Signal Street, Testpur'],
  ['SampleGram (Sample Social Inc.)', 'Social media platform', '', 'samplegram.example, sg.example', 'Nodal Officer (Synthetic)', 'lea@samplesocial.example', '', 'Online'],
  ['DemoChat Messenger', 'Messaging platform', '', 'demochat.example', 'Nodal Officer (Synthetic)', 'law.enforcement@demochat.example', '', 'Online'],
];
const wb2 = XLSX.utils.book_new();
const ws2 = XLSX.utils.aoa_to_sheet(nodal);
ws2['!cols'] = [30, 20, 12, 30, 26, 48, 34, 28].map((w) => ({ wch: w }));
XLSX.utils.book_append_sheet(wb2, ws2, 'Nodal Officers');
save(wb2, 'sample_nodal_officers.xlsx');

// A one-page synthetic "FIR copy" PDF, hand-written so no PDF library is needed.
function makePdf(lines) {
  const esc = (t) => t.replace(/[\\()]/g, (c) => '\\' + c);
  const content = 'BT /F1 12 Tf 60 780 Td 16 TL\n' + lines.map((l) => '(' + esc(l) + ') Tj T*').join('\n') + '\nET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; return at; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}
fs.writeFileSync(path.join(OUT, 'sample_fir_copy.pdf'), makePdf([
  'SYNTHETIC SAMPLE - NOT A REAL FIR',
  '',
  'FIRST INFORMATION REPORT (sample for testing the BNSS94 Notice Tool)',
  'FIR No.: 123/2026        Date: 01-03-2026',
  'Police Station: Cyber Crime PS, Testpur (fictional)',
  'Sections: 318(4) BNS; 66D IT Act (example only)',
  'NCRP Ack Nos: 99900000000101 to 99900000000108 (fictional)',
  '',
  'All names, numbers and details in this file are invented.',
]));

console.log('Wrote samples: ' + body.length + ' transaction rows, ' + (nodal.length - 1) + ' nodal entries.');
