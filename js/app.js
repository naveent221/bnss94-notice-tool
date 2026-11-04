/*
 * BNSS94 Notice Tool — UI controller.
 * Everything runs in this page. No network calls are made (and the page's
 * Content-Security-Policy blocks them). Only settings, column mappings, the
 * template and bank-matching fixes are stored, in localStorage.
 */
(function () {
  'use strict';
  var B = window.BNSS, T = window.BNSSTemplate;
  var O = window.BNSSOutputs.create({ docx: window.docx, XLSX: window.XLSX, JSZip: window.JSZip });

  // ------------------------------------------------------------------ storage
  var KEYS = {
    txnMap: 'bnss94.txnMapping', nodalMap: 'bnss94.nodalMapping', settings: 'bnss94.settings',
    template: 'bnss94.template', overrides: 'bnss94.bankOverrides', emails: 'bnss94.manualEmails'
  };
  function load(key, fallback) {
    try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  // -------------------------------------------------------------------- state
  var state = {
    txnFiles: [],        // [{name, wb, sheet, table}]
    nodalFile: null,     // {name, wb, sheet, table}
    txnMap: {}, nodalMap: {},
    analysis: null,
    directory: [],
    selected: {},        // account → true
    sort: { key: 'rank', dir: 1 },
    grouping: null,
    settings: load(KEYS.settings, {}),
    template: load(KEYS.template, null) || T.DEFAULT_TEMPLATE,
    overrides: load(KEYS.overrides, {}),
    manualEmails: load(KEYS.emails, {})
  };

  // ---------------------------------------------------------------- dom utils
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }
  function inr(p) { return B.formatINR(p); }

  function download(data, name, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function copyText(text) {
    var fallback = function () {
      var ta = el('textarea', { class: 'offscreen' }); ta.value = text;
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? 'Copied' : 'Copy failed — select and copy manually');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, fallback);
    } else fallback();
  }

  // ------------------------------------------------------------ file reading
  function readWorkbook(file) {
    return file.arrayBuffer().then(function (buf) {
      var isCsv = /\.csv$/i.test(file.name);
      // raw:true for CSV keeps long digit strings (account numbers) as text.
      return XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, raw: isCsv, dense: false });
    });
  }

  function sheetAoa(wb, name) {
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
  }

  /** Pick the sheet whose header row best matches the expected fields. */
  function bestSheet(wb, fields) {
    var best = wb.SheetNames[0], bestScore = -1;
    wb.SheetNames.forEach(function (n) {
      var t = B.tableFromAoa(sheetAoa(wb, n), fields);
      var m = B.guessMapping(t.headers, fields);
      var score = fields.filter(function (f) { return m[f.key]; }).length * 1000 + t.rows.length;
      if (score > bestScore) { bestScore = score; best = n; }
    });
    return best;
  }

  function loadFileEntry(file, fields) {
    return readWorkbook(file).then(function (wb) {
      var sheet = bestSheet(wb, fields);
      return { name: file.name, wb: wb, sheet: sheet, table: B.tableFromAoa(sheetAoa(wb, sheet), fields) };
    });
  }

  function handleTxnFiles(files) {
    clear($('upload-errors'));
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    Promise.all(list.map(function (f) { return loadFileEntry(f, B.TXN_FIELDS); })).then(function (entries) {
      state.txnFiles = entries;
      $('txn-files').textContent = entries.map(function (e) { return e.name + ' (' + e.table.rows.length + ' rows)'; }).join(', ');
      afterUpload();
    }).catch(uploadError);
  }

  function handleNodalFile(files) {
    clear($('upload-errors'));
    var f = files && files[0];
    if (!f) return;
    loadFileEntry(f, B.NODAL_FIELDS).then(function (entry) {
      state.nodalFile = entry;
      $('nodal-files').textContent = entry.name + ' (' + entry.table.rows.length + ' rows)';
      afterUpload();
    }).catch(uploadError);
  }

  function uploadError(err) {
    $('upload-errors').appendChild(el('div', { class: 'alert alert-bad', text: 'Could not read the file: ' + (err && err.message || err) }));
  }

  function txnHeaders() {
    var seen = {}, out = [];
    state.txnFiles.forEach(function (f) { f.table.headers.forEach(function (h) { if (!seen[h]) { seen[h] = 1; out.push(h); } }); });
    return out;
  }

  function txnRows() {
    var multi = state.txnFiles.length > 1, rows = [];
    state.txnFiles.forEach(function (f) {
      f.table.rows.forEach(function (r) {
        var copy = Object.assign({}, r);
        copy.__row = multi ? f.name + ':' + r.__row : r.__row;
        rows.push(copy);
      });
    });
    return rows;
  }

  function afterUpload() {
    if (state.txnFiles.length) {
      state.txnMap = B.guessMapping(txnHeaders(), B.TXN_FIELDS, load(KEYS.txnMap, null));
    }
    if (state.nodalFile) {
      state.nodalMap = B.guessMapping(state.nodalFile.table.headers, B.NODAL_FIELDS, load(KEYS.nodalMap, null));
    }
    state.analysis = null;
    ['step-results', 'step-banks', 'step-generate'].forEach(function (id) { show(id, false); });
    renderMapping();
  }

  // ---------------------------------------------------------------- mapping
  function sheetPicker(container, entries, fields, onChange) {
    clear(container);
    entries.forEach(function (entry) {
      if (entry.wb.SheetNames.length < 2) return;
      var sel = el('select', { 'aria-label': 'Sheet for ' + entry.name, onchange: function () {
        entry.sheet = sel.value;
        entry.table = B.tableFromAoa(sheetAoa(entry.wb, entry.sheet), fields);
        onChange();
      } }, entry.wb.SheetNames.map(function (n) { return el('option', { value: n, text: n, selected: n === entry.sheet }); }));
      container.appendChild(el('p', { class: 'small' }, [entry.name + ' — sheet: ', sel]));
    });
  }

  function mappingTable(table, fields, headers, mapping, onChange) {
    clear(table);
    fields.forEach(function (f) {
      var sel = el('select', { 'aria-label': f.label, onchange: function () { mapping[f.key] = sel.value; onChange(); } },
        [el('option', { value: '', text: '— not in file —' })].concat(headers.map(function (h) {
          return el('option', { value: h, text: h, selected: mapping[f.key] === h });
        })));
      var label = el('td', null, [f.label, f.required ? el('span', { class: 'req', text: ' *' }) : null]);
      var status = mapping[f.key] ? el('span', { class: 'badge badge-ok', text: 'mapped' })
        : el('span', { class: 'badge ' + (f.required ? 'badge-bad' : 'badge-warn'), text: f.required ? 'required' : 'optional' });
      table.appendChild(el('tr', null, [label, el('td', null, [sel]), el('td', null, [status])]));
    });
  }

  function renderMapping() {
    var hasTxn = state.txnFiles.length > 0, hasNodal = !!state.nodalFile;
    show('step-mapping', hasTxn || hasNodal);
    sheetPicker($('txn-sheets'), state.txnFiles, B.TXN_FIELDS, afterUpload);
    sheetPicker($('nodal-sheets'), hasNodal ? [state.nodalFile] : [], B.NODAL_FIELDS, afterUpload);
    if (hasTxn) mappingTable($('txn-map'), B.TXN_FIELDS, txnHeaders(), state.txnMap, renderMapping);
    else clear($('txn-map')).appendChild(el('tr', null, [el('td', { class: 'muted', text: 'Upload the NCRP export.' })]));
    if (hasNodal) mappingTable($('nodal-map'), B.NODAL_FIELDS, state.nodalFile.table.headers, state.nodalMap, renderMapping);
    else clear($('nodal-map'));
    show('nodal-missing', !hasNodal);
    renderPreview();
    $('map-errors').textContent = '';
  }

  function renderPreview() {
    var t = clear($('txn-preview'));
    if (!state.txnFiles.length) return;
    var headers = txnHeaders(), rows = txnRows().slice(0, 8);
    t.appendChild(el('tr', null, headers.map(function (h) { return el('th', { text: h }); })));
    rows.forEach(function (r) {
      t.appendChild(el('tr', null, headers.map(function (h) {
        var v = r[h]; return el('td', { text: v instanceof Date ? B.formatDate(v) : String(v == null ? '' : v) });
      })));
    });
  }

  function runAnalysis() {
    var missing = B.TXN_FIELDS.filter(function (f) { return f.required && !state.txnMap[f.key]; }).map(function (f) { return f.label; });
    if (!state.txnFiles.length) { $('map-errors').textContent = 'Upload the NCRP transaction export first.'; return; }
    if (missing.length) { $('map-errors').textContent = 'Map required column(s): ' + missing.join(', '); return; }
    save(KEYS.txnMap, state.txnMap);
    if (state.nodalFile) save(KEYS.nodalMap, state.nodalMap);

    state.analysis = B.analyse(txnRows(), state.txnMap, { layer: 1 });
    state.directory = state.nodalFile ? B.buildNodalDirectory(state.nodalFile.table.rows, state.nodalMap) : [];
    state.selected = {};
    state.analysis.accounts.forEach(function (a, i) { a.rank = i + 1; state.selected[a.account] = true; });
    state.sort = { key: 'rank', dir: 1 };
    refreshMatches();
    renderResults();
    ['step-results', 'step-banks', 'step-generate'].forEach(function (id) { show(id, true); });
    $('step-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function refreshMatches() {
    state.analysis.accounts.forEach(function (a) { a.match = B.matchBank(a.bank, a.ifsc, state.directory, state.overrides); });
  }

  // ----------------------------------------------------------------- results
  var COLS = [
    { key: 'sel', label: '' },
    { key: 'rank', label: '#', num: true },
    { key: 'account', label: 'Account No' },
    { key: 'bank', label: 'Bank' },
    { key: 'match', label: 'Nodal match' },
    { key: 'ifsc', label: 'IFSC' },
    { key: 'ackCount', label: 'Ack nos', num: true },
    { key: 'acks', label: 'Ack numbers' },
    { key: 'disputedPaise', label: 'Disputed ₹', num: true },
    { key: 'txnCount', label: 'Txns', num: true }
  ];

  function filteredAccounts() {
    var q = $('f-text').value.trim().toLowerCase();
    var rep = $('f-repeated').checked;
    var min = parseFloat($('f-min').value);
    var mf = $('f-match').value;
    var list = state.analysis.accounts.filter(function (a) {
      if (rep && a.ackCount < 2) return false;
      if (!isNaN(min) && a.disputedPaise < min * 100) return false;
      if (mf === 'matched' && !a.match.entry) return false;
      if (mf === 'unmatched' && a.match.entry) return false;
      if (q) {
        var hay = [a.account, a.bank, a.ifsc, a.acks.join(' '), a.match.entry ? a.match.entry.bank : ''].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var k = state.sort.key, d = state.sort.dir;
    list.sort(function (x, y) {
      var a = k === 'match' ? (x.match.entry ? x.match.entry.bank : '') : k === 'acks' ? x.acks.join(',') : k === 'sel' ? (state.selected[x.account] ? 1 : 0) : x[k];
      var b = k === 'match' ? (y.match.entry ? y.match.entry.bank : '') : k === 'acks' ? y.acks.join(',') : k === 'sel' ? (state.selected[y.account] ? 1 : 0) : y[k];
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * d || x.rank - y.rank;
      return String(a).localeCompare(String(b), undefined, { numeric: true }) * d || x.rank - y.rank;
    });
    return list;
  }

  function matchBadge(m) {
    if (!m.entry) return el('span', { class: 'badge badge-bad', text: 'unmatched' });
    var label = { ifsc: 'IFSC', name: 'name', manual: 'manual' }[m.method];
    var cls = m.entry.emails.length ? 'badge-ok' : 'badge-warn';
    return el('span', null, [m.entry.bank + ' ', el('span', { class: 'badge ' + cls, text: m.entry.emails.length ? label : 'no e-mail' })]);
  }

  function renderStats() {
    var s = state.analysis.stats;
    var tiles = [
      [s.totalRows, 'transaction rows'], [s.ackCount, 'Ack numbers'], [s.layerRows, 'Layer 1 rows'],
      [s.accountCount, 'Layer 1 accounts'], [s.repeatedCount, 'repeated across Acks'], ['₹ ' + inr(s.disputedPaise), 'Layer 1 disputed']
    ];
    var box = clear($('stats'));
    tiles.forEach(function (t) { box.appendChild(el('div', { class: 'tile' }, [el('div', { class: 'v', text: String(t[0]) }), el('div', { class: 'k', text: t[1] })])); });
    var w = clear($('warnings'));
    state.analysis.warnings.forEach(function (msg) { w.appendChild(el('li', { text: msg })); });
    if (!state.nodalFile) w.appendChild(el('li', { text: 'No nodal officers sheet loaded — e-mail IDs cannot be matched.' }));
  }

  function renderResults() {
    renderStats();
    var table = clear($('results'));
    var list = filteredAccounts();
    var head = el('tr', null, COLS.map(function (c) {
      if (c.key === 'sel') {
        var all = el('input', { type: 'checkbox', 'aria-label': 'Select all shown', onchange: function () { setSelection(list, all.checked); } });
        all.checked = list.length > 0 && list.every(function (a) { return state.selected[a.account]; });
        return el('th', null, [all]);
      }
      var cls = (c.num ? 'num ' : '') + (state.sort.key === c.key ? (state.sort.dir > 0 ? 'asc' : 'desc') : '');
      return el('th', { class: cls, 'data-key': c.key, text: c.label, onclick: function () {
        state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : (c.num && c.key !== 'rank' ? -1 : 1) };
        renderResults();
      } });
    }));
    table.appendChild(el('thead', null, [head]));
    var body = el('tbody');
    list.forEach(function (a) {
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Select ' + a.account, onchange: function () {
        if (cb.checked) state.selected[a.account] = true; else delete state.selected[a.account];
        tr.classList.toggle('selected', cb.checked); selectionChanged();
      } });
      cb.checked = !!state.selected[a.account];
      var tr = el('tr', { class: (cb.checked ? 'selected ' : '') + (a.match.entry ? '' : 'unmatched') }, [
        el('td', null, [cb]),
        el('td', { class: 'num', text: String(a.rank) }),
        el('td', { class: 'mono', text: a.account, title: a.warning || null }, a.warning ? [el('span', { class: 'badge badge-warn', text: '!' })] : []),
        el('td', { text: a.bank, title: a.bankVariants.join(' | ') }),
        el('td', null, [matchBadge(a.match)]),
        el('td', { class: 'mono', text: a.ifsc }),
        el('td', { class: 'num', text: String(a.ackCount) }),
        el('td', { class: 'acks', text: a.acks.join(', ') }),
        el('td', { class: 'num', text: inr(a.disputedPaise) }),
        el('td', { class: 'num', text: String(a.txnCount) })
      ]);
      body.appendChild(tr);
    });
    if (!list.length) body.appendChild(el('tr', null, [el('td', { colspan: String(COLS.length), class: 'muted', text: 'No accounts match the filter.' })]));
    table.appendChild(body);
    selectionChanged();
  }

  function setSelection(list, on) {
    list.forEach(function (a) { if (on) state.selected[a.account] = true; else delete state.selected[a.account]; });
    renderResults();
  }

  function selectedAccounts() {
    return state.analysis.accounts.filter(function (a) { return state.selected[a.account]; });
  }

  function selectionChanged() {
    var sel = selectedAccounts();
    var total = sel.reduce(function (s, a) { return s + a.disputedPaise; }, 0);
    $('sel-summary').textContent = sel.length + ' of ' + state.analysis.accounts.length + ' accounts selected · ₹ ' + inr(total) + ' disputed';
    renderBanks();
  }

  // ------------------------------------------------------------------- banks
  function computeGroups() {
    var g = B.groupByBank(selectedAccounts(), state.directory, state.overrides);
    g.groups.forEach(function (grp) {
      if (!grp.emails.length) {
        var manual = state.manualEmails[grp.entry ? 'N:' + B.normBankName(grp.entry.bank) : grp.normName];
        if (manual && manual.length) { grp.emails = manual.slice(); grp.manualEmails = true; }
      }
    });
    g.unmatched = g.groups.filter(function (x) { return !x.entry || !x.emails.length; });
    O.assignFileNames(g.groups, currentSettings());
    state.grouping = g;
    return g;
  }

  function renderBanks() {
    var g = computeGroups();
    var box = clear($('unmatched-box'));
    var noEntry = g.groups.filter(function (x) { return !x.entry; });
    var noMail = g.groups.filter(function (x) { return !x.emails.length; });
    if (noEntry.length || noMail.length) {
      box.appendChild(el('div', { class: 'alert alert-bad' }, [
        el('strong', { text: noEntry.length + ' bank(s) not found in the nodal sheet, ' + noMail.length + ' without an e-mail. ' }),
        'Pick the right bank from the list or type the e-mail ID(s). Fixes are remembered for next time.'
      ]));
    } else if (g.groups.length) {
      box.appendChild(el('div', { class: 'alert alert-ok', text: 'All ' + g.groups.length + ' bank(s) matched to nodal e-mail IDs.' }));
    }

    var t = clear($('banks'));
    t.appendChild(el('tr', null, ['Bank (nodal sheet)', 'Names in NCRP data', 'Match', 'Accounts', 'Disputed ₹', 'Nodal e-mail(s)', 'Fix'].map(function (h, i) {
      return el('th', { class: i === 3 || i === 4 ? 'num' : '', text: h });
    })));
    g.groups.forEach(function (grp) {
      var fix = null;
      if (!grp.entry || grp.method === 'manual' || !grp.emails.length) fix = fixControls(grp);
      t.appendChild(el('tr', { class: grp.entry && grp.emails.length ? '' : 'unmatched' }, [
        el('td', null, [grp.entry ? grp.bankName : el('span', { class: 'badge badge-bad', text: 'UNMATCHED' })]),
        el('td', { text: grp.rawNames.join('; ') }),
        el('td', { text: O.methodText(grp) }),
        el('td', { class: 'num', text: String(grp.accounts.length) }),
        el('td', { class: 'num', text: inr(grp.disputedPaise) }),
        el('td', { text: grp.emails.join('; ') || '—' }),
        el('td', null, [fix])
      ]));
    });
    if (!g.groups.length) t.appendChild(el('tr', null, [el('td', { colspan: '7', class: 'muted', text: 'No accounts selected.' })]));
    renderEmails();
  }

  function fixControls(grp) {
    var wrap = el('div', { class: 'fix' });
    var nameKeys = {};
    grp.rawNames.forEach(function (n) { nameKeys[B.normBankName(n)] = true; });
    if (!grp.rawNames.length) nameKeys[grp.normName] = true;
    if (!grp.entry || grp.method === 'manual') {
      var current = Object.keys(nameKeys).map(function (k) { return state.overrides[k]; }).filter(Boolean)[0] || '';
      var sel = el('select', { 'aria-label': 'Assign nodal bank', onchange: function () {
        Object.keys(nameKeys).forEach(function (k) { if (sel.value) state.overrides[k] = sel.value; else delete state.overrides[k]; });
        save(KEYS.overrides, state.overrides);
        refreshMatches(); renderResults();
      } }, [el('option', { value: '', text: grp.suggestion ? '— choose (closest: ' + grp.suggestion.bank + ') —' : '— choose nodal bank —' })]
        .concat(state.directory.map(function (d) { return el('option', { value: d.bank, text: d.bank, selected: d.bank === current }); })));
      wrap.appendChild(sel);
    }
    if (!grp.emails.length || grp.manualEmails) {
      var key = grp.entry ? 'N:' + B.normBankName(grp.entry.bank) : grp.normName;
      var input = el('input', { type: 'text', placeholder: 'e-mail(s), comma separated', 'aria-label': 'Manual e-mail IDs', value: (state.manualEmails[key] || []).join(', ') });
      var btn = el('button', { type: 'button', class: 'btn btn-small', text: 'Use', onclick: function () {
        var emails = B.extractEmails(input.value);
        if (emails.length) state.manualEmails[key] = emails; else delete state.manualEmails[key];
        save(KEYS.emails, state.manualEmails);
        renderBanks();
      } });
      wrap.appendChild(el('div', null, [input, ' ', btn]));
    }
    return wrap;
  }

  // ---------------------------------------------------------------- generate
  function currentSettings() {
    var s = Object.assign({}, state.settings);
    s.caseRef = $('g-caseref').value.trim();
    s.noticeDate = $('g-date').value.trim() || B.formatDate(new Date());
    return s;
  }

  function renderEmails() {
    var g = state.grouping, t = clear($('emails'));
    t.appendChild(el('tr', null, ['Bank', 'Nodal e-mail(s)', 'Attachment', 'Accounts', ''].map(function (h) { return el('th', { text: h }); })));
    g.groups.forEach(function (grp) {
      var emails = grp.emails.join('; ');
      t.appendChild(el('tr', { class: grp.emails.length ? '' : 'unmatched' }, [
        el('td', { text: grp.bankName }),
        el('td', { text: emails || 'NOT FOUND' }),
        el('td', { class: 'mono', text: grp.fileName }),
        el('td', { class: 'num', text: String(grp.accounts.length) }),
        el('td', null, [
          el('button', { type: 'button', class: 'btn btn-small', text: 'Copy e-mails', disabled: !emails, onclick: function () { copyText(emails); } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Preview', onclick: function () { previewNotice(grp); } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: '.docx', onclick: function () { downloadOne(grp); } })
        ])
      ]));
    });
    var none = !g.groups.length;
    $('btn-zip').disabled = none; $('btn-xlsx').disabled = none; $('btn-copy-tsv').disabled = none;
  }

  function buildContext() {
    var g = computeGroups();
    state.analysis.accounts.forEach(function (a) { a.selected = !!state.selected[a.account]; });
    return { analysis: state.analysis, accounts: state.analysis.accounts, groups: g.groups, unmatched: g.unmatched, settings: currentSettings() };
  }

  function preflight() {
    var unknown = B.unknownPlaceholders(state.template);
    if (unknown.length && !window.confirm('The template has unknown placeholder(s): ' + unknown.join(', ') + '. They will be left as-is. Continue?')) return false;
    var s = state.settings;
    if (!(s.officerName && s.designation && s.station) && !window.confirm('Officer name, designation or station is empty, so the signature block will be blank. Continue?')) return false;
    return true;
  }

  function stamp() { var d = new Date(); return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2); }

  function downloadZip() {
    if (!preflight()) return;
    var ctx = buildContext(), status = $('gen-status');
    status.textContent = 'Building ' + ctx.groups.length + ' notice(s)…';
    $('btn-zip').disabled = true;
    O.bundleZip(ctx, state.template).then(function (blob) {
      download(blob, 'BNSS94_Notices_' + stamp() + '.zip');
      status.textContent = 'Done: ' + ctx.groups.length + ' notice(s)' + (ctx.unmatched.length ? ' — ' + ctx.unmatched.length + ' bank(s) still need an e-mail ID.' : '.');
    }).catch(function (e) { status.textContent = 'Failed: ' + e.message; })
      .then(function () { $('btn-zip').disabled = false; });
  }

  function downloadXlsx() {
    var ctx = buildContext();
    download(O.summaryXlsx(ctx), 'BNSS94_Summary_' + stamp() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  function downloadOne(grp) {
    if (!preflight()) return;
    O.noticeDocx(grp, state.template, currentSettings()).then(function (blob) { download(blob, grp.fileName); });
  }

  function renderBlocks(blocks, container) {
    clear(container);
    blocks.forEach(function (b) {
      if (b.type === 'table') {
        container.appendChild(el('table', null, [el('tr', null, b.headers.map(function (h) { return el('th', { text: h }); }))]
          .concat(b.rows.map(function (r) { return el('tr', null, r.map(function (v) { return el('td', { text: v }); })); }))));
        return;
      }
      container.appendChild(el('p', { class: b.align }, b.runs.map(function (r) {
        var node = document.createTextNode(r.text);
        if (r.underline) node = el('u', null, [node]);
        if (r.bold) node = el('strong', null, [node]);
        return node;
      })));
    });
  }

  function previewNotice(grp, template) {
    var values = T.valuesFor(grp, currentSettings());
    renderBlocks(T.toBlocks(template || state.template, values, grp.accounts), $('preview-body'));
    $('dlg-preview').showModal();
  }

  /** A stand-in group so the template can be previewed before any data is loaded. */
  function demoGroup() {
    if (state.grouping && state.grouping.groups.length) return state.grouping.groups[0];
    return { bankName: 'Example Bank', acks: ['99900000000101'], disputedPaise: 1000000, entry: null,
      accounts: [{ account: '000123456789', ifsc: 'EXMP0000001', acks: ['99900000000101'], disputedPaise: 1000000, txnCount: 1 }] };
  }

  // ---------------------------------------------------------------- settings
  var SETTING_FIELDS = ['officerName', 'designation', 'station', 'phone', 'officerEmail'];
  function openSettings() {
    var form = $('dlg-settings').querySelector('form');
    SETTING_FIELDS.forEach(function (k) { form.elements[k].value = state.settings[k] || ''; });
    $('dlg-settings').showModal();
  }
  function settingsClosed() {
    var dlg = $('dlg-settings');
    if (dlg.returnValue !== 'save') return;
    var form = dlg.querySelector('form');
    SETTING_FIELDS.forEach(function (k) { state.settings[k] = form.elements[k].value.trim(); });
    toast(save(KEYS.settings, state.settings) ? 'Officer settings saved' : 'Settings applied (browser storage unavailable — not saved)');
    officerWarning();
  }
  function officerWarning() {
    var s = state.settings;
    show('officer-warning', !(s.officerName && s.designation && s.station));
  }

  // ---------------------------------------------------------------- template
  function openTemplate() {
    $('tpl-text').value = state.template;
    templateWarn();
    $('dlg-template').showModal();
  }
  function templateWarn() {
    var text = $('tpl-text').value, msgs = [];
    var unknown = B.unknownPlaceholders(text);
    if (unknown.length) msgs.push('Unknown placeholder(s): ' + unknown.join(', '));
    if (!/\{\{\s*accounts_table\s*\}\}/i.test(text)) msgs.push('No {{accounts_table}} — the notice will not list the accounts.');
    $('tpl-warn').textContent = msgs.join(' · ');
  }
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length; ta.focus(); templateWarn();
  }

  // ------------------------------------------------------------------ wiring
  function wireDrop(zone, input, handler) {
    input.addEventListener('change', function () { handler(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { handler(e.dataTransfer.files); });
  }

  function init() {
    wireDrop($('drop-txn'), $('file-txn'), handleTxnFiles);
    wireDrop($('drop-nodal'), $('file-nodal'), handleNodalFile);
    // Stop the browser opening a file dropped outside the drop zones.
    ['dragover', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); }); });

    $('btn-analyse').addEventListener('click', runAnalysis);
    ['f-text', 'f-min'].forEach(function (id) { $(id).addEventListener('input', renderResults); });
    ['f-repeated', 'f-match'].forEach(function (id) { $(id).addEventListener('change', renderResults); });
    $('sel-visible').addEventListener('click', function () { setSelection(filteredAccounts(), true); });
    $('unsel-visible').addEventListener('click', function () { setSelection(filteredAccounts(), false); });
    $('sel-default').addEventListener('click', function () {
      $('f-text').value = ''; $('f-min').value = ''; $('f-repeated').checked = false; $('f-match').value = '';
      state.sort = { key: 'rank', dir: 1 };
      setSelection(state.analysis.accounts, true);
    });

    $('g-date').value = B.formatDate(new Date());
    ['g-caseref', 'g-date'].forEach(function (id) { $(id).addEventListener('input', function () { if (state.analysis) renderBanks(); }); });
    $('btn-zip').addEventListener('click', downloadZip);
    $('btn-xlsx').addEventListener('click', downloadXlsx);
    $('btn-copy-tsv').addEventListener('click', function () { copyText(O.emailTsv(state.grouping.groups)); });

    $('btn-settings').addEventListener('click', openSettings);
    document.querySelectorAll('[data-open=settings]').forEach(function (b) { b.addEventListener('click', openSettings); });
    $('dlg-settings').addEventListener('close', settingsClosed);

    $('btn-template').addEventListener('click', openTemplate);
    var chips = $('tpl-chips');
    B.PLACEHOLDERS.forEach(function (p) {
      chips.appendChild(el('button', { type: 'button', class: 'chip', title: p[1], text: '{{' + p[0] + '}}', onclick: function () { insertAtCursor($('tpl-text'), '{{' + p[0] + '}}'); } }));
    });
    $('tpl-text').addEventListener('input', templateWarn);
    $('tpl-save').addEventListener('click', function () {
      state.template = $('tpl-text').value;
      toast(save(KEYS.template, state.template) ? 'Template saved' : 'Template applied (browser storage unavailable — not saved)');
    });
    $('tpl-default').addEventListener('click', function () {
      if (window.confirm('Replace the editor contents with the default Section 94 BNSS template?')) { $('tpl-text').value = T.DEFAULT_TEMPLATE; templateWarn(); }
    });
    $('tpl-preview').addEventListener('click', function () { previewNotice(demoGroup(), $('tpl-text').value); });
    $('tpl-export').addEventListener('click', function () { download($('tpl-text').value, 'bnss94_template.txt', 'text/plain;charset=utf-8'); });
    $('tpl-import').addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      f.text().then(function (txt) { $('tpl-text').value = txt; templateWarn(); toast('Imported — click Save to keep it'); });
      this.value = '';
    });
    $('tpl-close').addEventListener('click', function () { $('dlg-template').close(); });
    $('preview-close').addEventListener('click', function () { $('dlg-preview').close(); });

    $('btn-reset').addEventListener('click', function () {
      if (!window.confirm('Clear the loaded files and results from this page? Settings and template are kept.')) return;
      window.location.reload();
    });

    officerWarning();
  }

  init();
})();
