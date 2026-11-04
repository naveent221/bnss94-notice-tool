/*
 * BNSS94 Notice Tool — analysis logic.
 *
 * Pure functions only: no DOM, no network, no storage. Works in the browser
 * (exposed as window.BNSS) and in Node (module.exports) so it can be tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BNSS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Field definitions
  // ---------------------------------------------------------------------------

  /** Fields of the NCRP transaction export the user maps headers to. */
  var TXN_FIELDS = [
    { key: 'ack', label: 'Ack No', required: true,
      synonyms: ['acknowledgement no', 'acknowledgement number', 'acknowledgment no', 'ack no', 'ack number', 'ack', 'complaint id', 'complaint no'] },
    { key: 'account', label: 'Account No', required: true,
      synonyms: ['account no', 'account number', 'account no wallet pg pa id', 'beneficiary account no', 'beneficiary account', 'acct no', 'a c no', 'ac no', 'account id', 'wallet id'] },
    { key: 'bank', label: 'Bank Name', required: true,
      synonyms: ['bank name', 'bank fis', 'bank fi', 'bank', 'beneficiary bank', 'bank wallet', 'name of bank'] },
    { key: 'ifsc', label: 'IFSC',
      synonyms: ['ifsc code', 'ifsc', 'ifsc no', 'beneficiary ifsc'] },
    { key: 'layer', label: 'Layer',
      synonyms: ['layer', 'layer no', 'layer number', 'level'] },
    { key: 'txnId', label: 'Transaction ID / UTR',
      synonyms: ['transaction id utr number', 'transaction id utr', 'utr number', 'utr no', 'utr', 'transaction id', 'txn id', 'rrn', 'reference no'] },
    { key: 'txnDate', label: 'Transaction Date',
      synonyms: ['transaction date', 'txn date', 'date of transaction', 'date'] },
    { key: 'amount', label: 'Amount',
      synonyms: ['transaction amount', 'txn amount', 'amount', 'amount rs'] },
    { key: 'disputed', label: 'Disputed Amount',
      synonyms: ['disputed amount', 'dispute amount', 'disputed amt', 'fraud amount', 'amount disputed'] },
    { key: 'holdAmount', label: 'Put on Hold Amount',
      synonyms: ['put on hold amount', 'amount put on hold', 'hold amount', 'put on hold', 'lien amount', 'amount on hold'] },
    { key: 'phone', label: 'Suspect Mobile No(s)',
      synonyms: ['suspect mobile no', 'suspect mobile number', 'suspect mobile', 'suspect phone', 'mobile no', 'mobile number', 'phone number', 'phone no'] },
    { key: 'url', label: 'Suspect URL(s)',
      synonyms: ['suspect url', 'suspect website', 'url', 'website', 'web url', 'link'] },
    { key: 'socialId', label: 'Suspect Social Media / UPI / E-mail ID(s)',
      synonyms: ['suspect social media id', 'social media id', 'suspect id', 'social media handle', 'social media', 'upi id', 'suspect email'] }
  ];

  /** Fields of the nodal-officer sheet. */
  var NODAL_FIELDS = [
    { key: 'bank', label: 'Bank Name', required: true,
      synonyms: ['bank name', 'bank', 'name of bank', 'bank fi', 'institution', 'entity name'] },
    { key: 'ifscPrefix', label: 'IFSC Prefix',
      synonyms: ['ifsc prefix', 'ifsc code prefix', 'ifsc', 'bank code', 'ifsc first 4'] },
    { key: 'email', label: 'Email ID(s)', required: true,
      synonyms: ['email ids', 'email id', 'email', 'e mail', 'nodal email', 'mail id', 'emails'] },
    { key: 'email2', label: 'Email ID(s) (2nd column)',
      synonyms: ['alternate email', 'email 2', 'email id 2', 'cc email', 'secondary email'] },
    { key: 'contact', label: 'Nodal Officer Name',
      synonyms: ['nodal officer name', 'nodal officer', 'officer name', 'contact person', 'name'] },
    { key: 'address', label: 'Address',
      synonyms: ['address', 'postal address', 'office address'] },
    { key: 'category', label: 'Category (Bank / Telecom / Platform / Payment)',
      synonyms: ['category', 'entity type', 'type of entity', 'sector', 'type'] },
    { key: 'domains', label: 'Domains / UPI handles',
      synonyms: ['domains', 'domain', 'website domains', 'websites', 'upi handles', 'domains upi handles'] }
  ];

  /** Recipient categories. Banks and payment entities receive account-based notices. */
  var CATEGORIES = {
    bank: 'Bank',
    payment: 'Payment / Wallet',
    telecom: 'Telecom (TSP)',
    platform: 'Platform / Intermediary'
  };

  function normCategory(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    if (!s.trim()) return 'bank';
    if (/tele|tsp|mobile|operator|cellular|isp/.test(s)) return 'telecom';
    if (/wallet|payment|\bpa\b|\bpg\b|upi|fintech/.test(s)) return 'payment';
    if (/social|platform|intermediar|messag|\bapp\b|website|internet|e-?mail|host|registrar|domain/.test(s)) return 'platform';
    return 'bank';
  }

  function isAccountCategory(c) { return c === 'bank' || c === 'payment'; }

  // ---------------------------------------------------------------------------
  // String helpers
  // ---------------------------------------------------------------------------

  function normHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function bigrams(s) {
    var out = [];
    for (var i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
    return out;
  }

  /** Sørensen–Dice similarity on character bigrams (0..1). */
  function dice(a, b) {
    a = String(a).replace(/\s+/g, '');
    b = String(b).replace(/\s+/g, '');
    if (!a.length || !b.length) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    var A = bigrams(a), B = bigrams(b), counts = {}, hits = 0;
    A.forEach(function (g) { counts[g] = (counts[g] || 0) + 1; });
    B.forEach(function (g) { if (counts[g] > 0) { counts[g]--; hits++; } });
    return (2 * hits) / (A.length + B.length);
  }

  function headerScore(header, synonyms) {
    var h = normHeader(header);
    if (!h) return 0;
    var best = 0;
    synonyms.forEach(function (syn) {
      var s;
      if (h === syn) s = 1;
      else if ((' ' + h + ' ').indexOf(' ' + syn + ' ') >= 0) s = 0.75 + 0.2 * (syn.length / h.length);
      else s = dice(h, syn) * 0.8;
      if (s > best) best = s;
    });
    return best;
  }

  /**
   * Guess a mapping {fieldKey: headerName} from detected headers.
   * `remembered` (optional) is a previous mapping; it wins whenever its header
   * still exists. Remaining fields are assigned greedily, best score first, and
   * a header is never used for two fields.
   */
  function guessMapping(headers, fields, remembered) {
    var mapping = {}, used = {};
    fields.forEach(function (f) { mapping[f.key] = ''; });
    if (remembered) {
      fields.forEach(function (f) {
        var h = remembered[f.key];
        if (h && headers.indexOf(h) >= 0 && !used[h]) { mapping[f.key] = h; used[h] = true; }
      });
    }
    var cands = [];
    fields.forEach(function (f) {
      if (mapping[f.key]) return;
      headers.forEach(function (h) {
        var s = headerScore(h, f.synonyms);
        if (s >= 0.55) cands.push({ field: f.key, header: h, score: s });
      });
    });
    cands.sort(function (a, b) { return b.score - a.score; });
    cands.forEach(function (c) {
      if (mapping[c.field] || used[c.header]) return;
      mapping[c.field] = c.header; used[c.header] = true;
    });
    return mapping;
  }

  // ---------------------------------------------------------------------------
  // Value normalisation
  // ---------------------------------------------------------------------------

  var INVISIBLE = /[​-‍﻿ ]/g;

  /**
   * Normalise an identifier (account no, ack no, UTR) to a string.
   * Never converts to Number: leading zeros and long digit strings survive.
   * Returns { value, warning }.
   */
  function normId(raw) {
    if (raw == null) return { value: '', warning: null };
    var warning = null, s;
    if (typeof raw === 'number') {
      // Spreadsheet stored the id as a number. Integers up to 2^53 are exact;
      // anything larger has already lost digits inside the spreadsheet.
      if (Number.isSafeInteger(raw)) s = String(raw);
      else {
        s = raw.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 0 });
        warning = 'stored as a number in Excel; digits beyond 15 may be lost — re-export with the column as Text';
      }
    } else {
      s = String(raw);
    }
    s = s.replace(INVISIBLE, ' ').trim();
    s = s.replace(/^['`‘’]+/, '');   // leading apostrophes used to force text
    s = s.replace(/\s+/g, '');
    if (/^\d+(\.\d+)?e\+\d+$/i.test(s)) {
      warning = 'appears in scientific notation (e.g. 1.23E+15); the original digits are lost — re-export with the column as Text';
    }
    return { value: s.toUpperCase(), warning: warning };
  }

  /** Parse an amount like "₹ 1,23,456.50", "Rs. 500/-", 1200 into paise (integer). */
  function parseAmountPaise(raw) {
    if (raw == null || raw === '') return 0;
    if (typeof raw === 'number') return isFinite(raw) ? Math.round(raw * 100) : 0;
    var s = String(raw).replace(INVISIBLE, '').replace(/rs\.?|inr|₹|\/-/gi, '').replace(/[,\s]/g, '');
    var neg = /^\(.*\)$/.test(s) || /^-/.test(s);
    s = s.replace(/[()\-+]/g, '');
    var m = s.match(/\d+(\.\d+)?/);
    if (!m) return 0;
    var v = Math.round(parseFloat(m[0]) * 100);
    return neg ? -v : v;
  }

  function paiseToNumber(p) { return Math.round(p) / 100; }

  /** Indian-grouped rupee string, e.g. 1234567.5 → "12,34,567.50". */
  function formatINR(paise) {
    var neg = paise < 0; paise = Math.abs(Math.round(paise));
    var rupees = Math.floor(paise / 100), ps = String(paise % 100);
    if (ps.length < 2) ps = '0' + ps;
    var r = String(rupees), last3 = r.slice(-3), rest = r.slice(0, -3);
    if (rest) last3 = ',' + last3;
    rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (neg ? '-' : '') + rest + last3 + '.' + ps;
  }

  /** Extract the layer number from 1, "1", "Layer 1", "Layer-1", "L1". Returns NaN if none. */
  function parseLayer(raw) {
    if (raw == null || raw === '') return NaN;
    if (typeof raw === 'number') return Math.trunc(raw);
    var m = String(raw).match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatDate(raw) {
    if (raw == null || raw === '') return '';
    // ISO timestamps appear when case data comes back from a JSON backup.
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) raw = new Date(raw);
    if (raw instanceof Date && !isNaN(raw)) {
      return pad2(raw.getDate()) + '-' + pad2(raw.getMonth() + 1) + '-' + raw.getFullYear();
    }
    return String(raw).trim();
  }

  function normIfsc(raw) {
    return String(raw == null ? '' : raw).replace(INVISIBLE, '').replace(/[\s'`]/g, '').toUpperCase();
  }

  function ifscPrefix(ifsc) {
    var s = normIfsc(ifsc);
    return /^[A-Z]{4}/.test(s) ? s.slice(0, 4) : '';
  }

  function extractEmails(raw) {
    var m = String(raw == null ? '' : raw).match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    return m ? m.map(function (e) { return e.toLowerCase(); }) : [];
  }

  // ---------------------------------------------------------------------------
  // Bank-name matching
  // ---------------------------------------------------------------------------

  var STOP_WORDS = { THE: 1, LTD: 1, LIMITED: 1, PVT: 1, PRIVATE: 1, CO: 1, COMPANY: 1, INC: 1, CORP: 1, CORPORATION: 1 };
  var ACRONYM_SKIP = { OF: 1, AND: 1, THE: 1, LTD: 1, LIMITED: 1 };

  /** Canonical form used to compare bank names. */
  function normBankName(name) {
    var s = String(name == null ? '' : name).toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
    return s.split(' ').filter(function (t) { return t && !STOP_WORDS[t]; }).join(' ');
  }

  function acronym(name) {
    return String(name || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim()
      .split(' ').filter(function (t) { return t && !ACRONYM_SKIP[t]; })
      .map(function (t) { return t[0]; }).join('');
  }

  /** Similarity between two bank names (0..1). */
  function bankSimilarity(a, b) {
    var na = normBankName(a), nb = normBankName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    var ca = na.replace(/ /g, ''), cb = nb.replace(/ /g, '');
    if (ca === cb) return 1;
    // "SBI" vs "State Bank of India"; also "SBI BANK" → "SBI"
    var stripBank = function (s) { return s.replace(/\bBANK\b/g, '').replace(/\s+/g, ''); };
    var sa = stripBank(na), sb = stripBank(nb);
    if (sa && sb && (sa === acronym(b) || sb === acronym(a))) return 0.95;
    if (sa && sb && sa === sb) return 0.97;
    var ta = na.split(' '), tb = nb.split(' '), setB = {}, inter = 0;
    tb.forEach(function (t) { setB[t] = 1; });
    ta.forEach(function (t) { if (setB[t]) inter++; });
    var jac = inter / (ta.length + tb.length - inter);
    return Math.max(dice(ca, cb), jac);
  }

  var BANK_MATCH_THRESHOLD = 0.82;

  /**
   * Prepare the nodal list: [{ id, bank, ifscPrefixes[], emails[], contact, address }].
   * Rows with the same bank name are merged (emails unioned).
   */
  function buildNodalDirectory(rows, mapping) {
    var byName = {}, list = [];
    rows.forEach(function (r) {
      var bank = String(r[mapping.bank] == null ? '' : r[mapping.bank]).trim();
      if (!bank) return;
      var key = normBankName(bank);
      var entry = byName[key];
      if (!entry) {
        entry = byName[key] = { id: 'N' + (list.length + 1), bank: bank, ifscPrefixes: [], emails: [], contact: '', address: '',
          category: normCategory(mapping.category ? r[mapping.category] : ''), domains: [] };
        list.push(entry);
      }
      if (mapping.domains) {
        String(r[mapping.domains] == null ? '' : r[mapping.domains]).split(/[,;\s]+/).forEach(function (d) {
          d = d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^@/, '').replace(/\/.*$/, '');
          if (d && entry.domains.indexOf(d) < 0) entry.domains.push(d);
        });
      }
      if (mapping.ifscPrefix) {
        String(r[mapping.ifscPrefix] == null ? '' : r[mapping.ifscPrefix]).split(/[,;\/\s]+/).forEach(function (p) {
          p = ifscPrefix(p);
          if (p && entry.ifscPrefixes.indexOf(p) < 0) entry.ifscPrefixes.push(p);
        });
      }
      ['email', 'email2'].forEach(function (k) {
        if (!mapping[k]) return;
        extractEmails(r[mapping[k]]).forEach(function (e) { if (entry.emails.indexOf(e) < 0) entry.emails.push(e); });
      });
      if (mapping.contact && !entry.contact) entry.contact = String(r[mapping.contact] || '').trim();
      if (mapping.address && !entry.address) entry.address = String(r[mapping.address] || '').trim();
    });
    return list;
  }

  /**
   * Match a bank (name + IFSC) to the nodal directory.
   * Order: manual override → IFSC prefix → fuzzy bank name.
   * Returns { entry, method, score } (entry null when unmatched).
   */
  function matchBank(bankName, ifsc, directory, overrides) {
    var key = normBankName(bankName);
    // Telecom operators and platforms never receive account notices.
    directory = (directory || []).filter(function (d) { return !d.category || isAccountCategory(d.category); });
    if (overrides && overrides[key]) {
      var o = directory.filter(function (d) { return d.id === overrides[key] || d.bank === overrides[key]; })[0];
      if (o) return { entry: o, method: 'manual', score: 1 };
    }
    var pfx = ifscPrefix(ifsc);
    if (pfx) {
      var byIfsc = directory.filter(function (d) { return d.ifscPrefixes.indexOf(pfx) >= 0; })[0];
      if (byIfsc) return { entry: byIfsc, method: 'ifsc', score: 1 };
    }
    var best = null, bestScore = 0;
    directory.forEach(function (d) {
      var s = bankSimilarity(bankName, d.bank);
      if (s > bestScore) { bestScore = s; best = d; }
    });
    if (best && bestScore >= BANK_MATCH_THRESHOLD) return { entry: best, method: 'name', score: bestScore };
    return { entry: null, method: 'none', score: bestScore, suggestion: best };
  }

  // ---------------------------------------------------------------------------
  // Sheet helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the header row in an array-of-arrays (NCRP exports sometimes have
   * title rows above the header). Picks the row among the first 25 with the
   * most cells that look like known headers.
   */
  function detectHeaderRow(aoa, fields) {
    var bestRow = 0, bestScore = -1;
    var limit = Math.min(aoa.length, 25);
    for (var i = 0; i < limit; i++) {
      var row = aoa[i] || [], score = 0, filled = 0;
      row.forEach(function (c) {
        if (c == null || c === '') return;
        filled++;
        if (typeof c !== 'string') return;
        var best = 0;
        fields.forEach(function (f) { best = Math.max(best, headerScore(c, f.synonyms)); });
        if (best >= 0.6) score += best;
      });
      score += filled * 0.01;
      if (score > bestScore) { bestScore = score; bestRow = i; }
    }
    return bestRow;
  }

  /** Convert array-of-arrays to { headers, rows: [{header: value}] } using the detected header row. */
  function tableFromAoa(aoa, fields) {
    var h = detectHeaderRow(aoa, fields);
    var seen = {};
    var headers = (aoa[h] || []).map(function (c, i) {
      var name = String(c == null ? '' : c).replace(/\s+/g, ' ').trim() || ('Column ' + (i + 1));
      if (seen[name]) { seen[name]++; name = name + ' (' + seen[name] + ')'; } else seen[name] = 1;
      return name;
    });
    var rows = [];
    for (var r = h + 1; r < aoa.length; r++) {
      var arr = aoa[r] || [], obj = {}, any = false;
      headers.forEach(function (name, i) {
        var v = arr[i];
        if (v !== undefined && v !== null && v !== '') any = true;
        obj[name] = v === undefined ? '' : v;
      });
      if (any) { obj.__row = r + 1; rows.push(obj); }
    }
    return { headers: headers, rows: rows, headerRow: h + 1 };
  }

  // ---------------------------------------------------------------------------
  // Core analysis
  // ---------------------------------------------------------------------------

  function mostCommon(counts) {
    var best = '', n = -1;
    Object.keys(counts).forEach(function (k) { if (counts[k] > n) { n = counts[k]; best = k; } });
    return best;
  }

  /**
   * Analyse transaction rows.
   *
   * @param rows      array of {header: value} objects (may come from several files)
   * @param mapping   {fieldKey: headerName}
   * @param options   { layer: 1, assumeLayer1IfUnmapped: true }
   * @returns {
   *   accounts: [...Layer-1 accounts, sorted by ackCount desc then disputed desc],
   *   stats, warnings: [string], skipped: [{row, reason}]
   * }
   */
  function analyse(rows, mapping, options) {
    options = options || {};
    var targetLayer = options.layer == null ? 1 : options.layer;
    var warnings = [], skipped = [], idWarnings = {};
    var stats = { totalRows: rows.length, layerRows: 0, duplicateRows: 0, acks: {}, layers: {} };
    var hasLayer = !!mapping.layer;
    if (!hasLayer) warnings.push('No "Layer" column mapped — every row is treated as Layer ' + targetLayer + '.');

    var accounts = {}, seenTxn = {}, ackInfo = {};
    var missing = { bank: 0, txnId: 0, amount: 0, ifsc: 0 };
    rows.forEach(function (r) {
      var get = function (k) { return mapping[k] ? r[mapping[k]] : ''; };
      var ack = normId(get('ack')).value;
      var accN = normId(get('account'));
      var acc = accN.value;
      var layer = hasLayer ? parseLayer(get('layer')) : targetLayer;
      var txnId = normId(get('txnId')).value;
      var amount = parseAmountPaise(get('amount'));
      var disputed = mapping.disputed ? parseAmountPaise(get('disputed')) : amount;
      var hold = mapping.holdAmount ? parseAmountPaise(get('holdAmount')) : 0;
      if (ack) stats.acks[ack] = true;
      if (!isNaN(layer)) stats.layers[layer] = (stats.layers[layer] || 0) + 1;

      // Exact duplicate rows (same ack, layer, account, UTR and amounts) are counted once.
      var sig = [ack, layer, acc, txnId, amount, disputed, hold, formatDate(get('txnDate'))].join('|');
      if (txnId && seenTxn[sig]) { if (layer === targetLayer) stats.duplicateRows++; return; }
      seenTxn[sig] = true;

      if (ack) {
        var ai = ackInfo[ack] || (ackInfo[ack] = { ack: ack, lossPaise: 0, holdPaise: 0, layers: {}, rowCount: 0, l1Accounts: {} });
        ai.rowCount++;
        ai.holdPaise += hold;
        if (!isNaN(layer)) ai.layers[layer] = true;
        if (layer === targetLayer) { ai.lossPaise += disputed; if (acc) ai.l1Accounts[acc] = true; }
      }

      if (layer !== targetLayer) return;
      stats.layerRows++;
      if (!acc) { skipped.push({ row: r.__row, reason: 'blank account number' }); return; }
      if (!ack) { skipped.push({ row: r.__row, reason: 'blank Ack No' }); return; }
      if (accN.warning) idWarnings[acc] = accN.warning;
      if (!String(get('bank') == null ? '' : get('bank')).trim()) missing.bank++;
      if (!txnId) missing.txnId++;
      if (!disputed && !amount) missing.amount++;
      if (!normIfsc(get('ifsc'))) missing.ifsc++;

      var a = accounts[acc];
      if (!a) {
        a = accounts[acc] = { account: acc, ackSet: {}, ackOrder: [], bankCounts: {}, ifscCounts: {},
          disputedPaise: 0, amountPaise: 0, txnCount: 0, transactions: [] };
      }
      if (!a.ackSet[ack]) { a.ackSet[ack] = 0; a.ackOrder.push(ack); }
      a.ackSet[ack] += disputed;
      var bank = String(get('bank') == null ? '' : get('bank')).replace(/\s+/g, ' ').trim();
      if (bank) a.bankCounts[bank] = (a.bankCounts[bank] || 0) + 1;
      var ifsc = normIfsc(get('ifsc'));
      if (ifsc) a.ifscCounts[ifsc] = (a.ifscCounts[ifsc] || 0) + 1;
      a.disputedPaise += disputed;
      a.amountPaise += amount;
      a.txnCount++;
      a.transactions.push({ ack: ack, txnId: txnId, date: formatDate(get('txnDate')), amountPaise: amount, disputedPaise: disputed, row: r.__row });
    });

    var list = Object.keys(accounts).map(function (k) {
      var a = accounts[k];
      return {
        account: a.account,
        bank: mostCommon(a.bankCounts),
        ifsc: mostCommon(a.ifscCounts),
        acks: a.ackOrder.slice().sort(),
        ackCount: a.ackOrder.length,
        disputedPaise: a.disputedPaise,
        amountPaise: a.amountPaise,
        txnCount: a.txnCount,
        transactions: a.transactions,
        warning: idWarnings[a.account] || null,
        bankVariants: Object.keys(a.bankCounts)
      };
    });
    list.sort(defaultSort);

    Object.keys(idWarnings).forEach(function (acc) {
      warnings.push('Account ' + acc + ' ' + idWarnings[acc] + '.');
    });
    if (stats.duplicateRows) warnings.push(stats.duplicateRows + ' exact duplicate transaction row(s) were counted once.');
    if (skipped.length) warnings.push(skipped.length + ' Layer ' + targetLayer + ' row(s) skipped (blank account or Ack No).');

    var ackSummary = Object.keys(ackInfo).sort().map(function (k) {
      var a = ackInfo[k];
      return { ack: a.ack, lossPaise: a.lossPaise, holdPaise: a.holdPaise, rowCount: a.rowCount,
        layers: Object.keys(a.layers).map(Number).sort(function (x, y) { return x - y; }),
        l1AccountCount: Object.keys(a.l1Accounts).length };
    });

    return {
      accounts: list,
      ackSummary: ackSummary,
      stats: {
        totalLossPaise: ackSummary.reduce(function (s, a) { return s + a.lossPaise; }, 0),
        totalHoldPaise: ackSummary.reduce(function (s, a) { return s + a.holdPaise; }, 0),
        holdMapped: !!mapping.holdAmount,
        missing: missing,
        totalRows: stats.totalRows,
        layerRows: stats.layerRows,
        duplicateRows: stats.duplicateRows,
        ackCount: Object.keys(stats.acks).length,
        acks: Object.keys(stats.acks).sort(),
        layers: stats.layers,
        accountCount: list.length,
        repeatedCount: list.filter(function (a) { return a.ackCount > 1; }).length,
        disputedPaise: list.reduce(function (s, a) { return s + a.disputedPaise; }, 0)
      },
      warnings: warnings,
      skipped: skipped
    };
  }

  /** Default ranking: repeat count (Ack nos) desc, then disputed amount desc, then account. */
  function defaultSort(a, b) {
    return (b.ackCount - a.ackCount) || (b.disputedPaise - a.disputedPaise) || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
  }

  /**
   * Group selected accounts by matched nodal bank.
   * Unmatched banks are grouped by their normalised name and flagged.
   * Returns { groups: [{key, bankName, entry, method, accounts, acks, disputedPaise, emails, rawNames}], unmatched: [...] }
   */
  function groupByBank(accounts, directory, overrides) {
    var groups = {}, order = [];
    accounts.forEach(function (acc) {
      var m = matchBank(acc.bank, acc.ifsc, directory, overrides);
      var key = m.entry ? m.entry.id : 'U:' + (normBankName(acc.bank) || '(blank bank name)');
      var g = groups[key];
      if (!g) {
        g = groups[key] = {
          key: key,
          kind: (m.entry && m.entry.category) || 'bank',
          bankName: m.entry ? m.entry.bank : (acc.bank || '(blank bank name)'),
          entry: m.entry,
          method: m.method,
          methods: {},
          suggestion: m.entry ? null : (m.suggestion && m.score >= 0.5 ? m.suggestion : null),
          normName: normBankName(acc.bank),
          rawNames: [],
          accounts: [],
          ackSet: {},
          disputedPaise: 0,
          emails: m.entry ? m.entry.emails.slice() : []
        };
        order.push(key);
      }
      g.methods[m.method] = true;
      if (acc.bank && g.rawNames.indexOf(acc.bank) < 0) g.rawNames.push(acc.bank);
      g.accounts.push(acc);
      acc.acks.forEach(function (k) { g.ackSet[k] = true; });
      g.disputedPaise += acc.disputedPaise;
    });
    var list = order.map(function (k) {
      var g = groups[k];
      g.acks = Object.keys(g.ackSet).sort();
      delete g.ackSet;
      g.accounts.sort(defaultSort);
      return g;
    });
    list.sort(function (a, b) {
      if (!!a.entry !== !!b.entry) return a.entry ? 1 : -1; // unmatched first so they are noticed
      return (b.accounts.length - a.accounts.length) || (b.disputedPaise - a.disputedPaise);
    });
    return { groups: list, unmatched: list.filter(function (g) { return !g.entry || !g.emails.length; }) };
  }

  // ---------------------------------------------------------------------------
  // Non-account identifiers: phone numbers, URLs, social media / UPI / e-mail IDs
  // ---------------------------------------------------------------------------

  var ID_TYPES = { phone: 'Mobile number', url: 'URL / website', social: 'Social media ID', email: 'E-mail ID', upi: 'UPI ID', other: 'Other' };

  function hostOf(url) {
    var m = String(url).toLowerCase().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@\/]*@)?([^\/?#:]+)/);
    return m ? m[1].replace(/^www\./, '').replace(/\.$/, '') : '';
  }

  /**
   * Classify one identifier. `hint` is the column it came from: 'phone' | 'url' | 'social' | ''.
   * Returns { type, value, domain, key, warning } or null for blanks.
   */
  function classifyIdentifier(raw, hint) {
    var s = String(raw == null ? '' : raw).replace(INVISIBLE, ' ').trim().replace(/^['`]+/, '');
    if (!s || /^(na|n\/a|nil|none|-|0)$/i.test(s)) return null;
    var out = { type: 'other', value: s, domain: '', warning: null };
    var digits = s.replace(/[\s\-().]/g, '');
    var isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^www\./i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?(\/|$)/i.test(s) && !/@/.test(s) && !/^\+?\d[\d.]*$/.test(s);
    if (/^\+?\d+$/.test(digits) && hint !== 'url' && hint !== 'social' || hint === 'phone' && /^\+?[\d\s\-()]+$/.test(s)) {
      var d = digits.replace(/^\+/, '');
      if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
      else if (d.length === 11 && d[0] === '0') d = d.slice(1);
      out.type = 'phone'; out.value = d;
      if (!/^[6-9]\d{9}$/.test(d)) out.warning = 'not a 10-digit Indian mobile number';
    } else if (isUrl) {
      var url = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
      out.domain = hostOf(url);
      out.type = hint === 'social' ? 'social' : 'url';
      out.value = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^\/?#]+)/i, function (m, p, h) { return p.toLowerCase() + h.toLowerCase(); }).replace(/\/$/, '');
    } else if (/^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s)) {
      out.type = 'email'; out.value = s.toLowerCase(); out.domain = s.split('@')[1].toLowerCase();
    } else if (/^[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9]*$/.test(s)) {
      out.type = 'upi'; out.value = s.toLowerCase(); out.domain = s.split('@')[1].toLowerCase();
    } else if (hint === 'social' || /^@/.test(s)) {
      out.type = 'social'; out.value = s.replace(/^@/, '').toLowerCase();
    }
    out.key = out.type + ':' + out.value;
    return out;
  }

  function splitIdentifiers(cell) {
    return String(cell == null ? '' : cell).split(/[\n,;|]+|\s{2,}|\s+\/\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /** Merge identifiers into a list keyed by type:value, accumulating Ack numbers. */
  function addIdentifier(map, order, item, ack, source) {
    var cur = map[item.key];
    if (!cur) {
      cur = map[item.key] = { key: item.key, type: item.type, value: item.value, domain: item.domain, warning: item.warning, acks: [], sources: [] };
      order.push(item.key);
    }
    if (ack && cur.acks.indexOf(ack) < 0) cur.acks.push(ack);
    if (source && cur.sources.indexOf(source) < 0) cur.sources.push(source);
    return cur;
  }

  /** Pull suspect phone numbers / URLs / social IDs out of the mapped export columns (all layers). */
  function extractIdentifiers(rows, mapping, extra) {
    var map = {}, order = [];
    var cols = [['phone', 'phone'], ['url', 'url'], ['socialId', 'social']];
    rows.forEach(function (r) {
      var ack = mapping.ack ? normId(r[mapping.ack]).value : '';
      cols.forEach(function (c) {
        if (!mapping[c[0]]) return;
        splitIdentifiers(r[mapping[c[0]]]).forEach(function (v) {
          var item = classifyIdentifier(v, c[1]);
          if (item) addIdentifier(map, order, item, ack, 'export');
        });
      });
    });
    (extra || []).forEach(function (x) {
      var item = classifyIdentifier(x.value, x.hint || '');
      if (!item) return;
      var cur = addIdentifier(map, order, item, '', 'manual');
      (x.acks || []).forEach(function (a) { if (cur.acks.indexOf(a) < 0) cur.acks.push(a); });
    });
    return order.map(function (k) { map[k].acks.sort(); return map[k]; });
  }

  /**
   * Find the nodal entry for an identifier.
   * Order: manual assignment → domain / UPI-handle match. Phones need an assignment
   * (mobile number portability makes the number series unreliable).
   */
  function matchIdentifier(item, directory, assignments) {
    var a = assignments && assignments[item.key];
    if (a) {
      var e = directory.filter(function (d) { return d.bank === a || d.id === a; })[0];
      if (e) return { entry: e, method: 'manual' };
    }
    if (item.domain) {
      var hit = directory.filter(function (d) {
        return d.domains.some(function (dom) { return item.domain === dom || item.domain.slice(-(dom.length + 1)) === '.' + dom; });
      })[0];
      if (hit) return { entry: hit, method: 'domain' };
    }
    return { entry: null, method: 'none' };
  }

  /** Group selected identifiers by recipient (telecom operator, platform, payment entity …). */
  function groupIdentifiers(items, directory, assignments) {
    var groups = {}, order = [];
    items.forEach(function (it) {
      var m = matchIdentifier(it, directory, assignments);
      var key = m.entry ? m.entry.id : 'U:' + it.type;
      var g = groups[key];
      if (!g) {
        g = groups[key] = {
          key: key, kind: m.entry ? m.entry.category : 'unassigned', bankName: m.entry ? m.entry.bank : 'Unassigned ' + ID_TYPES[it.type],
          entry: m.entry, method: m.method, methods: {}, rawNames: [], accounts: [], items: [], ackSet: {}, disputedPaise: 0,
          emails: m.entry ? m.entry.emails.slice() : [], normName: key
        };
        order.push(key);
      }
      g.methods[m.method] = true;
      g.items.push(it);
      it.acks.forEach(function (k) { g.ackSet[k] = true; });
    });
    var list = order.map(function (k) { var g = groups[k]; g.acks = Object.keys(g.ackSet).sort(); delete g.ackSet; return g; });
    list.sort(function (a, b) { return (!!a.entry === !!b.entry) ? b.items.length - a.items.length : (a.entry ? 1 : -1); });
    return list;
  }

  // ---------------------------------------------------------------------------
  // Mandatory-field checks for a case (FIR)
  // ---------------------------------------------------------------------------

  /**
   * @param c  { firNo, firDate, policeStation, sections, hasFirCopy, hasExport }
   * @param settings officer settings
   * @param analysis result of analyse() (optional)
   * @param groups   recipient groups (optional)
   * @returns [{ field, message, level: 'missing' | 'warning' }]
   */
  function checkCase(c, settings, analysis, groups) {
    var out = [];
    var need = function (ok, field, message) { if (!ok) out.push({ field: field, message: message, level: 'missing' }); };
    c = c || {}; settings = settings || {};
    need(String(c.firNo || '').trim(), 'firNo', 'FIR number');
    need(String(c.firDate || '').trim(), 'firDate', 'FIR date');
    need(String(c.policeStation || '').trim(), 'policeStation', 'Police station of the FIR');
    need(String(c.sections || '').trim(), 'sections', 'Sections of law');
    need(c.hasFirCopy, 'firCopy', 'FIR copy (PDF / image)');
    need(c.hasExport, 'export', 'NCRP transaction export');
    need(settings.officerName && settings.designation, 'officer', 'Officer name and designation (Officer settings)');
    need(settings.officerEmail, 'officerEmail', 'Officer e-mail (Officer settings) — needed on the notice and e-mail drafts');
    if (analysis) {
      var s = analysis.stats;
      need(s.ackCount > 0, 'acks', 'NCRP Acknowledgement numbers (none found in the export)');
      if (s.ackCount > 0 && !s.accountCount) out.push({ field: 'layer1', message: 'No Layer 1 accounts found — check the Layer column mapping', level: 'missing' });
      var m = s.missing || {};
      if (m.bank) out.push({ field: 'rows.bank', message: m.bank + ' Layer 1 row(s) without a bank name', level: 'missing' });
      if (m.amount) out.push({ field: 'rows.amount', message: m.amount + ' Layer 1 row(s) without an amount', level: 'missing' });
      if (m.txnId) out.push({ field: 'rows.txnId', message: m.txnId + ' Layer 1 row(s) without a Transaction ID / UTR', level: 'warning' });
      if (m.ifsc) out.push({ field: 'rows.ifsc', message: m.ifsc + ' Layer 1 row(s) without IFSC (bank matched by name only)', level: 'warning' });
    }
    (groups || []).forEach(function (g) {
      if (!g.entry) out.push({ field: 'recipient:' + g.key, message: 'No nodal officer chosen for ' + g.bankName, level: 'missing' });
      else if (!g.emails.length) out.push({ field: 'email:' + g.key, message: 'No nodal e-mail ID for ' + g.bankName, level: 'missing' });
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Template rendering (text level; the Word layout is built in outputs.js)
  // ---------------------------------------------------------------------------

  var PLACEHOLDERS = [
    ['date', 'Notice date'],
    ['bank_name', 'Bank name (as in nodal sheet)'],
    ['accounts_table', 'Table of accounts (put on its own line)'],
    ['ack_numbers', 'Comma-separated NCRP Ack numbers'],
    ['officer_name', 'Your name'],
    ['designation', 'Your designation'],
    ['station', 'Police station / unit'],
    ['case_ref', 'Case / FIR / notice reference'],
    ['phone', 'Your phone'],
    ['officer_email', 'Your email'],
    ['account_count', 'Number of accounts'],
    ['total_disputed', 'Total disputed amount (₹)'],
    ['nodal_officer', 'Nodal officer name from sheet'],
    ['bank_address', 'Bank address from sheet'],
    ['identifiers_table', 'Same as accounts_table (tables of accounts / identifiers)'],
    ['requested_items', 'Numbered list of documents requested (put on its own line)'],
    ['requested_list', 'Documents requested, as one line (for the subject)'],
    ['items_description', 'What is listed, e.g. "account(s) maintained with your bank"'],
    ['item_count', 'Number of accounts / identifiers'],
    ['fir_no', 'FIR number'],
    ['fir_date', 'FIR date'],
    ['police_station', 'Police station of the FIR'],
    ['sections', 'Sections of law'],
    ['period', 'Period of records requested'],
    ['notice_ref', 'Unique notice reference (used to match replies)'],
    ['reply_by', 'Date by which the reply is due'],
    ['total_loss', 'Total loss in the complaint(s) (₹)'],
    ['hold_amount', 'Total amount put on hold (₹)']
  ];

  /** Replace {{placeholders}} in a string. Unknown placeholders are left intact. */
  function fillPlaceholders(text, values) {
    return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (m, name) {
      name = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : m;
    });
  }

  function unknownPlaceholders(text) {
    var known = {}, out = [];
    PLACEHOLDERS.forEach(function (p) { known[p[0]] = 1; });
    String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (m, name) {
      name = name.toLowerCase();
      if (!known[name] && out.indexOf(name) < 0) out.push(name);
      return m;
    });
    return out;
  }

  /** Safe file name fragment. */
  function safeFileName(s) {
    return String(s || '').replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/[^A-Za-z0-9 ._()-]+/g, '').trim()
      .replace(/\s+/g, '_').slice(0, 80) || 'Bank';
  }

  function noticeFileName(bankName, caseRef) {
    var ref = caseRef ? safeFileName(caseRef) + '_' : '';
    return 'Sec94_BNSS_' + ref + safeFileName(bankName) + '.docx';
  }

  return {
    TXN_FIELDS: TXN_FIELDS,
    NODAL_FIELDS: NODAL_FIELDS,
    CATEGORIES: CATEGORIES,
    ID_TYPES: ID_TYPES,
    normCategory: normCategory,
    isAccountCategory: isAccountCategory,
    hostOf: hostOf,
    classifyIdentifier: classifyIdentifier,
    splitIdentifiers: splitIdentifiers,
    extractIdentifiers: extractIdentifiers,
    matchIdentifier: matchIdentifier,
    groupIdentifiers: groupIdentifiers,
    checkCase: checkCase,
    PLACEHOLDERS: PLACEHOLDERS,
    BANK_MATCH_THRESHOLD: BANK_MATCH_THRESHOLD,
    normHeader: normHeader,
    dice: dice,
    headerScore: headerScore,
    guessMapping: guessMapping,
    normId: normId,
    parseAmountPaise: parseAmountPaise,
    paiseToNumber: paiseToNumber,
    formatINR: formatINR,
    parseLayer: parseLayer,
    formatDate: formatDate,
    normIfsc: normIfsc,
    ifscPrefix: ifscPrefix,
    extractEmails: extractEmails,
    normBankName: normBankName,
    acronym: acronym,
    bankSimilarity: bankSimilarity,
    buildNodalDirectory: buildNodalDirectory,
    matchBank: matchBank,
    detectHeaderRow: detectHeaderRow,
    tableFromAoa: tableFromAoa,
    analyse: analyse,
    defaultSort: defaultSort,
    groupByBank: groupByBank,
    fillPlaceholders: fillPlaceholders,
    unknownPlaceholders: unknownPlaceholders,
    safeFileName: safeFileName,
    noticeFileName: noticeFileName
  };
});
