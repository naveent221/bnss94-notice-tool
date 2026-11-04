/*
 * BNSS94 Notice Tool — notice template: default text, request catalogue and a
 * tiny markup parser.
 *
 * Template markup (plain text, one paragraph per line):
 *   {{placeholder}}        replaced with values (see BNSS.PLACEHOLDERS)
 *   {{accounts_table}}     on a line by itself → table(s) of the accounts /
 *                          identifiers for that recipient ({{identifiers_table}} is the same)
 *   {{requested_items}}    on a line by itself → numbered list of requested documents
 *   [center] ... / [right] ...   at the start of a line → alignment
 *   **bold**   __underline__      inline formatting
 *   blank line             → empty paragraph
 *
 * Pure functions; used for the HTML preview, the .docx and the e-mail drafts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analysis.js'));
  else root.BNSSTemplate = factory(root.BNSS);
})(typeof self !== 'undefined' ? self : this, function (BNSS) {
  'use strict';

  /**
   * Documents that can be requested. `cats` = recipient categories that get
   * the item ticked by default. "{{period}}" is dropped when no period is set.
   */
  var REQUEST_ITEMS = [
    { id: 'statement', short: 'Account Statement', cats: ['bank', 'payment'],
      label: 'Complete account statement from the date of opening of the account till date (in Excel and PDF format).' },
    { id: 'kyc', short: 'KYC details', cats: ['bank', 'payment', 'telecom'],
      label: 'KYC documents submitted by the account holder / subscriber (identity proof, address proof, registered mobile number and e-mail ID).' },
    { id: 'aof', short: 'Account Opening Form (AOF)', cats: ['bank', 'payment'],
      label: 'Account Opening Form (AOF) along with all enclosures.' },
    { id: 'photos', short: 'Photographs', cats: ['bank', 'payment', 'telecom'],
      label: 'Photograph(s) of the account holder / subscriber as available in your records.' },
    { id: 'aadhaar', short: 'Aadhaar', cats: ['bank', 'payment', 'telecom'],
      label: 'Copy of the Aadhaar card submitted.' },
    { id: 'pan', short: 'PAN', cats: ['bank', 'payment'],
      label: 'Copy of the PAN card submitted.' },
    { id: 'cdr', short: 'CDR', cats: ['telecom'],
      label: 'Call Detail Records (CDR) with cell-ID / tower location for the period {{period}}.' },
    { id: 'sdr', short: 'SDR / CAF', cats: ['telecom'],
      label: 'Subscriber Detail Record (SDR) and Customer Application Form (CAF) with the ID proofs submitted.' },
    { id: 'ipdr', short: 'IPDR', cats: ['telecom'],
      label: 'Internet Protocol Detail Records (IPDR) for the period {{period}}.' },
    { id: 'subscriber', short: 'Registration / subscriber details', cats: ['platform'],
      label: 'Registration / subscriber details of the account(s) (name, registered mobile number, e-mail ID, date of creation).' },
    { id: 'iplogs', short: 'IP logs', cats: ['platform'],
      label: 'Login and registration IP address logs with date, time (IST) and port for the period {{period}}.' },
    { id: 'linked', short: 'Linked accounts', cats: ['platform', 'payment'],
      label: 'Details of other accounts / profiles linked to the same mobile number, e-mail ID or device.' },
    { id: 'netbanking', short: 'Net-banking IP logs', cats: [],
      label: 'Internet / mobile banking login IP address logs and device details for the period {{period}}.' },
    { id: 'atm', short: 'ATM withdrawal CCTV', cats: [],
      label: 'Location and CCTV footage of ATM withdrawals, if any, from the above account(s).' }
  ];

  function defaultRequested(kind) {
    return REQUEST_ITEMS.filter(function (r) { return r.cats.indexOf(kind) >= 0; }).map(function (r) { return r.id; });
  }

  function requestedFor(group) {
    var ids = group.requested || defaultRequested(group.kind);
    return REQUEST_ITEMS.filter(function (r) { return ids.indexOf(r.id) >= 0; });
  }

  function itemLabel(item, period) {
    return period ? item.label.replace(/\{\{period\}\}/g, period) : item.label.replace(/\s*for the period \{\{period\}\}/g, '').replace(/\{\{period\}\}/g, '');
  }

  var DEFAULT_TEMPLATE = [
    '[center]**OFFICE OF THE {{station}}**',
    '[center]**__NOTICE UNDER SECTION 94 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023__**',
    '',
    'No.: {{notice_ref}}',
    '[right]Date: {{date}}',
    '',
    'To,',
    'The Nodal Officer,',
    '**{{bank_name}}**',
    '',
    '**Sub:** Request for production of {{requested_list}} under Section 94 of the BNSS, 2023 – reg.',
    '**Ref:** FIR No. {{fir_no}} dated {{fir_date}} u/s {{sections}}, {{police_station}}; NCRP Acknowledgement No(s).: {{ack_numbers}}',
    '',
    'Sir/Madam,',
    '',
    'A case has been registered vide the FIR cited above on complaint(s) of cyber financial fraud reported on the National Cybercrime Reporting Portal (NCRP). During investigation it has come to notice that the following {{items_description}} are involved in the offence:',
    '',
    '{{accounts_table}}',
    '',
    'The production of the documents mentioned below is necessary and desirable for the purpose of the said investigation. Therefore, in exercise of the powers conferred under Section 94 of the Bharatiya Nagarik Suraksha Sanhita, 2023, you are requested to furnish the following in respect of each of the above:',
    '',
    '{{requested_items}}',
    '',
    'A copy of the FIR is enclosed. You are requested to furnish the above information to the undersigned on or before {{reply_by}} by e-mail to {{officer_email}}, quoting the reference number {{notice_ref}}.',
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

  var DEFAULT_EMAIL_SUBJECT = 'Notice u/s 94 BNSS – {{bank_name}} – FIR {{fir_no}} [Ref: {{notice_ref}}]';

  var DEFAULT_EMAIL_BODY = [
    'Sir/Madam,',
    '',
    'Please find attached a notice under Section 94 of the Bharatiya Nagarik Suraksha Sanhita, 2023 requesting {{requested_list}} in respect of {{item_count}} item(s) connected with FIR No. {{fir_no}} dated {{fir_date}}, {{police_station}} (NCRP Ack No(s).: {{ack_numbers}}). A copy of the FIR is also attached.',
    '',
    'Kindly furnish the information by {{reply_by}}, keeping the reference {{notice_ref}} in the subject line of your reply.',
    '',
    'Regards,',
    '{{officer_name}}',
    '{{designation}}',
    '{{station}}',
    'Ph: {{phone}}'
  ].join('\n');

  var TABLE_HEADERS = ['S.No', 'Account No', 'IFSC', 'NCRP Ack No(s)', 'Disputed Amount (₹)', 'No. of Txns'];
  var ID_TABLE_HEADERS = ['S.No', 'Identifier', 'Type', 'NCRP Ack No(s)'];

  function tableRows(accounts) {
    return accounts.map(function (a, i) {
      return [String(i + 1), a.account, a.ifsc || '-', a.acks.join(', '), BNSS.formatINR(a.disputedPaise), String(a.txnCount)];
    });
  }

  function idTableRows(items) {
    return items.map(function (it, i) {
      return [String(i + 1), it.value, BNSS.ID_TYPES[it.type] || it.type, it.acks.join(', ') || '-'];
    });
  }

  function tablesFor(group) {
    var out = [];
    if (group.accounts && group.accounts.length) out.push({ type: 'table', headers: TABLE_HEADERS.slice(), rows: tableRows(group.accounts) });
    if (group.items && group.items.length) out.push({ type: 'table', headers: ID_TABLE_HEADERS.slice(), rows: idTableRows(group.items) });
    return out;
  }

  function plural(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }

  /** "2 accounts maintained with your bank and 1 UPI ID pertaining to your organisation" */
  function itemsDescription(group) {
    var parts = [], accs = (group.accounts || []).length, items = group.items || [];
    if (accs) parts.push(plural(accs, 'account') + ' maintained with your ' + (group.kind === 'payment' ? 'organisation' : 'bank') + ' (Layer 1 beneficiary accounts)');
    if (items.length) {
      var counts = {}, order = [];
      items.forEach(function (it) { if (!counts[it.type]) { counts[it.type] = 0; order.push(it.type); } counts[it.type]++; });
      var names = { phone: 'mobile number', url: 'URL', social: 'social media ID', email: 'e-mail ID', upi: 'UPI ID', other: 'identifier' };
      var where = group.kind === 'telecom' ? 'serviced by your network' : 'pertaining to your organisation';
      parts.push(order.map(function (t) { return plural(counts[t], names[t] || 'identifier'); }).join(', ') + ' ' + where);
    }
    return parts.join(' and ') || 'items';
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
   * `group` may be a bank group (accounts) or a recipient group with identifiers (items).
   * For backwards compatibility an array of accounts is accepted too.
   */
  function toBlocks(template, values, group) {
    if (Array.isArray(group)) group = { kind: 'bank', accounts: group, items: [] };
    var blocks = [];
    var requested = requestedFor(group).map(function (r) { return itemLabel(r, values.period); });
    var inlineValues = Object.assign({}, values, {
      accounts_table: (group.accounts || []).map(function (a) { return a.account; }).concat((group.items || []).map(function (i) { return i.value; })).join(', '),
      identifiers_table: (group.items || []).map(function (i) { return i.value; }).join(', '),
      requested_items: requested.join(' ')
    });
    String(template).replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
      var align = 'left';
      var m = line.match(/^\s*\[(center|centre|right|left)\]\s?/i);
      if (m) { align = m[1].toLowerCase() === 'centre' ? 'center' : m[1].toLowerCase(); line = line.slice(m[0].length); }
      if (/^\s*\{\{\s*(accounts_table|identifiers_table)\s*\}\}\s*$/i.test(line)) {
        var tables = tablesFor(group);
        tables.forEach(function (t, i) { if (i) blocks.push({ type: 'para', align: 'left', runs: [] }); blocks.push(t); });
        return;
      }
      if (/^\s*\{\{\s*requested_items\s*\}\}\s*$/i.test(line)) {
        requested.forEach(function (text, i) { blocks.push({ type: 'para', align: align, runs: [{ text: (i + 1) + '. ' + text }] }); });
        return;
      }
      blocks.push({ type: 'para', align: align, runs: parseRuns(BNSS.fillPlaceholders(line, inlineValues)) });
    });
    return blocks;
  }

  function addDays(dateStr, days) {
    var m = String(dateStr || '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    var d = m ? new Date(+m[3], +m[2] - 1, +m[1]) : new Date();
    d.setDate(d.getDate() + days);
    return BNSS.formatDate(d);
  }

  /**
   * Values for one recipient group.
   * @param settings officer settings + { noticeDate, caseRef, replyDays }
   * @param caseInfo { firNo, firDate, policeStation, sections, periodFrom, periodTo, totalLossPaise, holdPaise }
   */
  function valuesFor(group, settings, caseInfo) {
    settings = settings || {}; caseInfo = caseInfo || {};
    var date = settings.noticeDate || BNSS.formatDate(new Date());
    var requested = requestedFor(group);
    var period = caseInfo.periodFrom && caseInfo.periodTo ? caseInfo.periodFrom + ' to ' + caseInfo.periodTo
      : (caseInfo.periodFrom ? 'from ' + caseInfo.periodFrom + ' till date' : '');
    var count = (group.accounts || []).length + (group.items || []).length;
    return {
      date: date,
      bank_name: group.bankName,
      ack_numbers: (group.acks || []).join(', ') || '-',
      officer_name: settings.officerName || '',
      designation: settings.designation || '',
      station: settings.station || '',
      case_ref: settings.caseRef || caseInfo.firNo || '',
      phone: settings.phone || '',
      officer_email: settings.officerEmail || '',
      account_count: String(count),
      item_count: String(count),
      total_disputed: BNSS.formatINR(group.disputedPaise || 0),
      nodal_officer: (group.entry && group.entry.contact) || '',
      bank_address: (group.entry && group.entry.address) || '',
      requested_list: requested.map(function (r) { return r.short; }).join(', ') || 'documents',
      items_description: itemsDescription(group),
      fir_no: caseInfo.firNo || '',
      fir_date: caseInfo.firDate || '',
      police_station: caseInfo.policeStation || settings.station || '',
      sections: caseInfo.sections || '',
      period: period,
      notice_ref: group.noticeRef || settings.caseRef || caseInfo.firNo || '',
      reply_by: addDays(date, settings.replyDays == null ? 7 : +settings.replyDays),
      total_loss: BNSS.formatINR(caseInfo.totalLossPaise || 0),
      hold_amount: BNSS.formatINR(caseInfo.holdPaise || 0)
    };
  }

  /** Fill a plain-text template (e-mail subject / body). */
  function fillText(text, values) {
    return BNSS.fillPlaceholders(text, values).replace(/\*\*|__/g, '');
  }

  return {
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    DEFAULT_EMAIL_SUBJECT: DEFAULT_EMAIL_SUBJECT,
    DEFAULT_EMAIL_BODY: DEFAULT_EMAIL_BODY,
    REQUEST_ITEMS: REQUEST_ITEMS,
    TABLE_HEADERS: TABLE_HEADERS,
    ID_TABLE_HEADERS: ID_TABLE_HEADERS,
    defaultRequested: defaultRequested,
    requestedFor: requestedFor,
    itemsDescription: itemsDescription,
    parseRuns: parseRuns,
    toBlocks: toBlocks,
    valuesFor: valuesFor,
    fillText: fillText,
    addDays: addDays,
    tableRows: tableRows
  };
});
