/*
 * BNSS94 Notice Tool — notice template: default text and a tiny markup parser.
 *
 * Template markup (plain text, one paragraph per line):
 *   {{placeholder}}        replaced with values (see BNSS.PLACEHOLDERS)
 *   {{accounts_table}}     on a line by itself → a table of accounts
 *   [center] ... / [right] ...   at the start of a line → alignment
 *   **bold**   __underline__      inline formatting
 *   blank line             → empty paragraph
 *
 * Pure functions; used for both the HTML preview and the .docx output.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analysis.js'));
  else root.BNSSTemplate = factory(root.BNSS);
})(typeof self !== 'undefined' ? self : this, function (BNSS) {
  'use strict';

  var DEFAULT_TEMPLATE = [
    '[center]**OFFICE OF THE {{station}}**',
    '[center]**__NOTICE UNDER SECTION 94 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023__**',
    '',
    'No.: {{case_ref}}',
    '[right]Date: {{date}}',
    '',
    'To,',
    'The Nodal Officer,',
    '**{{bank_name}}**',
    '',
    '**Sub:** Request for production of Account Statement, KYC documents and Account Opening Form of the account(s) mentioned below under Section 94 of the BNSS, 2023 – reg.',
    '**Ref:** NCRP Acknowledgement No(s).: {{ack_numbers}}',
    '',
    'Sir/Madam,',
    '',
    'Complaint(s) of cyber financial fraud have been registered on the National Cybercrime Reporting Portal (NCRP) under the acknowledgement number(s) cited above. During enquiry it has come to notice that the amount(s) defrauded from the complainant(s) were credited to the following {{account_count}} account(s) maintained with your bank (Layer 1 beneficiary accounts):',
    '',
    '{{accounts_table}}',
    '',
    'The production of the documents mentioned below is necessary and desirable for the purpose of the said enquiry/investigation. Therefore, in exercise of the powers conferred under Section 94 of the Bharatiya Nagarik Suraksha Sanhita, 2023, you are requested to furnish the following in respect of each of the above account(s):',
    '',
    '1. Complete account statement from the date of opening of the account till date (in Excel and PDF format).',
    '2. KYC documents submitted by the account holder (identity proof, address proof, photograph, PAN, and the registered mobile number and e-mail ID).',
    '3. Account Opening Form (AOF) along with all enclosures.',
    '',
    'You are requested to furnish the above information to the undersigned at the earliest, preferably within three days of receipt of this notice, by e-mail to {{officer_email}}.',
    '',
    'This notice is issued in electronic form as provided under Section 94 of the BNSS, 2023.',
    '',
    '[right]Yours faithfully,',
    '',
    '',
    '[right]**{{officer_name}}**',
    '[right]{{designation}}',
    '[right]{{station}}',
    '[right]Ph: {{phone}}  |  E-mail: {{officer_email}}'
  ].join('\n');

  var TABLE_HEADERS = ['S.No', 'Account No', 'IFSC', 'NCRP Ack No(s)', 'Disputed Amount (₹)', 'No. of Txns'];

  function tableRows(accounts) {
    return accounts.map(function (a, i) {
      return [String(i + 1), a.account, a.ifsc || '-', a.acks.join(', '), BNSS.formatINR(a.disputedPaise), String(a.txnCount)];
    });
  }

  /** Split a line into runs, honouring **bold** and __underline__. */
  function parseRuns(text) {
    var runs = [], bold = false, underline = false, buf = '';
    var flush = function () { if (buf) { runs.push({ text: buf, bold: bold, underline: underline }); buf = ''; } };
    for (var i = 0; i < text.length; i++) {
      var two = text.substr(i, 2);
      if (two === '**') { flush(); bold = !bold; i++; continue; }
      if (two === '__') { flush(); underline = !underline; i++; continue; }
      buf += text[i];
    }
    flush();
    return runs;
  }

  /**
   * Turn a template + values into layout blocks:
   *   { type: 'para', align: 'left'|'center'|'right', runs: [{text,bold,underline}] }
   *   { type: 'table', headers: [...], rows: [[...]] }
   */
  function toBlocks(template, values, accounts) {
    var blocks = [];
    String(template).replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
      var align = 'left';
      var m = line.match(/^\s*\[(center|centre|right|left)\]\s?/i);
      if (m) { align = m[1].toLowerCase() === 'centre' ? 'center' : m[1].toLowerCase(); line = line.slice(m[0].length); }
      if (/^\s*\{\{\s*accounts_table\s*\}\}\s*$/i.test(line)) {
        blocks.push({ type: 'table', headers: TABLE_HEADERS.slice(), rows: tableRows(accounts) });
        return;
      }
      var inlineValues = Object.assign({}, values, {
        accounts_table: accounts.map(function (a) { return a.account; }).join(', ')
      });
      blocks.push({ type: 'para', align: align, runs: parseRuns(BNSS.fillPlaceholders(line, inlineValues)) });
    });
    return blocks;
  }

  /** Values for one bank group. */
  function valuesFor(group, settings) {
    settings = settings || {};
    return {
      date: settings.noticeDate || BNSS.formatDate(new Date()),
      bank_name: group.bankName,
      ack_numbers: group.acks.join(', '),
      officer_name: settings.officerName || '',
      designation: settings.designation || '',
      station: settings.station || '',
      case_ref: settings.caseRef || '',
      phone: settings.phone || '',
      officer_email: settings.officerEmail || '',
      account_count: String(group.accounts.length),
      total_disputed: BNSS.formatINR(group.disputedPaise),
      nodal_officer: (group.entry && group.entry.contact) || '',
      bank_address: (group.entry && group.entry.address) || ''
    };
  }

  return {
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    TABLE_HEADERS: TABLE_HEADERS,
    parseRuns: parseRuns,
    toBlocks: toBlocks,
    valuesFor: valuesFor,
    tableRows: tableRows
  };
});
