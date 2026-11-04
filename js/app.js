/*
 * BNSS94 Notice Tool — UI controller.
 *
 * Everything runs in this page. No network calls are made (and the page's
 * Content-Security-Policy blocks them). Cases (keyed by FIR number), FIR
 * copies and replies are stored in this browser's IndexedDB on this computer;
 * officer settings, templates and bank-name fixes in localStorage.
 */
(function () {
  'use strict';
  var B = window.BNSS, T = window.BNSSTemplate, M = window.BNSSMail, S = window.BNSSStore;
  var O = window.BNSSOutputs.create({ docx: window.docx, XLSX: window.XLSX, JSZip: window.JSZip });

  // ------------------------------------------------------------- localStorage
  var KEYS = {
    txnMap: 'bnss94.txnMapping', nodalMap: 'bnss94.nodalMapping', settings: 'bnss94.settings',
    template: 'bnss94.template', subject: 'bnss94.emailSubject', body: 'bnss94.emailBody',
    overrides: 'bnss94.bankOverrides', emails: 'bnss94.manualEmails', replyDays: 'bnss94.replyDays',
    helperPort: 'bnss94.helperPort', helperCode: 'bnss94.helperCode'
  };
  function load(key, fallback) {
    try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  // -------------------------------------------------------------------- state
  var state = {
    settings: load(KEYS.settings, {}),
    templates: {
      notice: load(KEYS.template, null) || T.DEFAULT_TEMPLATE,
      subject: load(KEYS.subject, null) || T.DEFAULT_EMAIL_SUBJECT,
      body: load(KEYS.body, null) || T.DEFAULT_EMAIL_BODY
    },
    overrides: load(KEYS.overrides, {}),
    manualEmails: load(KEYS.emails, {}),
    directory: [], dirInfo: null, nodalPending: null,
    cases: [],
    cur: null,          // open case record
    txnWorkbooks: {},   // file name → workbook (only right after upload, for sheet switching)
    analysis: null, identifiers: [], recipients: [], unmatched: [],
    sort: { key: 'rank', dir: 1 }
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
  function fmtIso(iso) { return iso ? B.formatDate(new Date(iso)) : ''; }
  function badge(text, kind) { return el('span', { class: 'badge badge-' + kind, text: text }); }

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
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, fallback);
    else fallback();
  }

  function prompt(title, items) {
    $('prompt-title').textContent = title;
    var body = clear($('prompt-body'));
    if (typeof items === 'string') body.appendChild(el('p', { text: items }));
    else body.appendChild(el('ul', { class: 'alerts' }, items.map(function (i) { return i instanceof Node ? el('li', null, [i]) : el('li', { text: i }); })));
    if (!$('dlg-prompt').open) $('dlg-prompt').showModal();
  }

  function fileBytes(file) { return file.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
  function newId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function stableKey(g) { return g.entry ? 'R:' + B.normBankName(g.entry.bank) : g.key; }

  // ------------------------------------------------------------ file reading
  function readWorkbook(file) {
    return file.arrayBuffer().then(function (buf) {
      // raw:true for CSV keeps long digit strings (account numbers) as text.
      return XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, raw: /\.csv$/i.test(file.name) });
    });
  }
  function sheetAoa(wb, name) {
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
  }
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

  function sheetPicker(container, entries, fields, onChange) {
    clear(container);
    entries.forEach(function (entry) {
      if (!entry.wb || entry.wb.SheetNames.length < 2) return;
      var sel = el('select', { 'aria-label': 'Sheet for ' + entry.name, onchange: function () {
        entry.sheet = sel.value;
        entry.table = B.tableFromAoa(sheetAoa(entry.wb, entry.sheet), fields);
        onChange(entry);
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
      var status = mapping[f.key] ? badge('mapped', 'ok') : badge(f.required ? 'required' : 'optional', f.required ? 'bad' : 'warn');
      table.appendChild(el('tr', null, [el('td', null, [f.label, f.required ? el('span', { class: 'req', text: ' *' }) : null]), el('td', null, [sel]), el('td', null, [status])]));
    });
  }

  // ===================================================== NODAL DIRECTORY
  function loadDirectory() {
    return S.get('meta', 'directory').then(function (d) {
      if (d && d.rows) {
        state.dirInfo = d;
        state.directory = B.buildNodalDirectory(d.rows, d.map);
      }
      renderDirectory();
    });
  }

  function handleNodalFile(files) {
    var f = files && files[0];
    if (!f) return;
    loadFileEntry(f, B.NODAL_FIELDS).then(function (entry) {
      entry.map = B.guessMapping(entry.table.headers, B.NODAL_FIELDS, load(KEYS.nodalMap, null));
      state.nodalPending = entry;
      renderNodalMapping();
    }).catch(function (e) { $('dir-errors').textContent = 'Could not read the file: ' + e.message; show('nodal-mapping', true); });
  }

  function renderNodalMapping() {
    var p = state.nodalPending;
    show('nodal-mapping', !!p);
    if (!p) return;
    sheetPicker($('nodal-sheets'), [p], B.NODAL_FIELDS, function () { p.map = B.guessMapping(p.table.headers, B.NODAL_FIELDS); renderNodalMapping(); });
    mappingTable($('nodal-map'), B.NODAL_FIELDS, p.table.headers, p.map, renderNodalMapping);
    $('dir-errors').textContent = '';
  }

  function saveDirectory() {
    var p = state.nodalPending;
    var missing = B.NODAL_FIELDS.filter(function (f) { return f.required && !p.map[f.key]; }).map(function (f) { return f.label; });
    if (missing.length) { $('dir-errors').textContent = 'Map required column(s): ' + missing.join(', '); return; }
    save(KEYS.nodalMap, p.map);
    var rec = { key: 'directory', name: p.name, rows: p.table.rows, map: p.map, loadedAt: new Date().toISOString() };
    S.put('meta', rec).then(function () {
      state.dirInfo = rec;
      state.directory = B.buildNodalDirectory(rec.rows, rec.map);
      state.nodalPending = null;
      show('nodal-mapping', false);
      renderDirectory();
      if (state.cur && state.analysis) recompute();
      toast('Nodal directory saved (' + state.directory.length + ' entries)');
    });
  }

  function renderDirectory() {
    var d = state.dirInfo;
    if (!d) { $('dir-status').textContent = 'No nodal officers sheet loaded yet. Upload it once — it is used for every case.'; clear($('dir-table')); return; }
    var counts = {};
    state.directory.forEach(function (e) { counts[e.category] = (counts[e.category] || 0) + 1; });
    $('dir-status').textContent = d.name + ' · loaded ' + fmtIso(d.loadedAt) + ' · ' + state.directory.length + ' entries (' +
      Object.keys(counts).map(function (k) { return counts[k] + ' ' + (B.CATEGORIES[k] || k); }).join(', ') + ')';
    var t = clear($('dir-table'));
    t.appendChild(el('tr', null, ['Name', 'Category', 'IFSC prefixes', 'Domains / UPI handles', 'E-mail(s)'].map(function (h) { return el('th', { text: h }); })));
    state.directory.forEach(function (e) {
      t.appendChild(el('tr', null, [el('td', { text: e.bank }), el('td', { text: B.CATEGORIES[e.category] || e.category }),
        el('td', { text: e.ifscPrefixes.join(', ') }), el('td', { text: e.domains.join(', ') }), el('td', { text: e.emails.join('; ') || '—' })]));
    });
  }

  function directoryOptions(selected, categories, placeholder) {
    var opts = [el('option', { value: '', text: placeholder || '— choose —' })];
    Object.keys(B.CATEGORIES).forEach(function (cat) {
      if (categories && categories.indexOf(cat) < 0) return;
      var entries = state.directory.filter(function (d) { return d.category === cat; });
      if (!entries.length) return;
      opts.push(el('optgroup', { label: B.CATEGORIES[cat] }, entries.map(function (d) {
        return el('option', { value: d.bank, text: d.bank, selected: d.bank === selected });
      })));
    });
    return opts;
  }

  // ========================================================== DASHBOARD
  function refreshCases() {
    return S.getAll('cases').then(function (list) {
      state.cases = list.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
      renderDashboard();
      return renderUnmatched();
    });
  }

  function caseChecks(c, analysis, groups) {
    return B.checkCase({
      firNo: c.firNo, firDate: c.firDate, policeStation: c.policeStation, sections: c.sections,
      hasFirCopy: !!c.firCopyId, hasExport: !!(c.export && c.export.files && c.export.files.length)
    }, state.settings, analysis, groups);
  }

  function noticeAlerts(c) {
    var now = Date.now(), out = [];
    (c.notices || []).forEach(function (n) {
      var unreviewed = (n.replies || []).filter(function (r) { return !r.reviewed; });
      if (unreviewed.length) out.push({ level: 'ok', type: 'reply', text: 'Reply received from ' + n.recipientName + ' (' + n.ref + ') — ' + unreviewed.length + ' to review', notice: n });
      else if (n.status === 'sent' && n.dueAt && Date.parse(n.dueAt) < now) out.push({ level: 'bad', type: 'overdue', text: 'No reply from ' + n.recipientName + ' (' + n.ref + ') — was due ' + fmtIso(n.dueAt), notice: n });
      else if (n.status === 'sent' && n.dueAt && Date.parse(n.dueAt) - now < 864e5) out.push({ level: 'warn', type: 'due', text: 'Reply from ' + n.recipientName + ' (' + n.ref + ') due ' + fmtIso(n.dueAt), notice: n });
    });
    return out;
  }

  function renderDashboard() {
    var alerts = clear($('alerts')), total = 0;
    state.cases.forEach(function (c) {
      noticeAlerts(c).forEach(function (a) {
        total++;
        alerts.appendChild(el('li', { class: 'alert-' + a.level }, ['FIR ' + c.firNo + ': ' + a.text + ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Open', onclick: function () { openCase(c.firNo, 'step-generate'); } })]));
      });
      var missing = caseChecks(c).filter(function (x) { return x.level === 'missing'; });
      if (missing.length) {
        total++;
        alerts.appendChild(el('li', { class: 'alert-warn' }, ['FIR ' + c.firNo + ': missing ' + missing.map(function (m) { return m.message; }).join(', ') + ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Fix', onclick: function () { openCase(c.firNo, 'step-case'); } })]));
      }
    });
    if (!total) alerts.appendChild(el('li', { class: 'muted', text: state.cases.length ? 'Nothing needs attention.' : 'No cases yet — click “New case”.' }));
    var ac = $('alert-count'); ac.textContent = String(total); ac.classList.toggle('hidden', !total);

    var t = clear($('cases'));
    t.appendChild(el('tr', null, ['FIR No', 'FIR date', 'Police station', 'Ack nos', 'Notices', 'Sent', 'Replies', 'Overdue', 'Missing fields', 'Updated', ''].map(function (h) { return el('th', { text: h }); })));
    state.cases.forEach(function (c) {
      var ns = c.notices || [];
      var overdue = noticeAlerts(c).filter(function (a) { return a.type === 'overdue'; }).length;
      var missing = caseChecks(c).filter(function (x) { return x.level === 'missing'; }).length;
      t.appendChild(el('tr', null, [
        el('td', null, [el('button', { type: 'button', class: 'linklike', text: c.firNo, onclick: function () { openCase(c.firNo); } })]),
        el('td', { text: c.firDate || '' }), el('td', { text: c.policeStation || '' }),
        el('td', { class: 'num', text: String((c.ackList || []).length) }),
        el('td', { class: 'num', text: String(ns.length) }),
        el('td', { class: 'num', text: String(ns.filter(function (n) { return n.status !== 'generated'; }).length) }),
        el('td', { class: 'num', text: String(ns.filter(function (n) { return (n.replies || []).length; }).length) }),
        el('td', { class: 'num' }, [overdue ? badge(String(overdue), 'bad') : '0']),
        el('td', { class: 'num' }, [missing ? badge(String(missing), 'warn') : badge('0', 'ok')]),
        el('td', { text: fmtIso(c.updatedAt) }),
        el('td', null, [el('button', { type: 'button', class: 'btn btn-small', text: 'Open', onclick: function () { openCase(c.firNo); } })])
      ]));
    });
    if (!state.cases.length) t.appendChild(el('tr', null, [el('td', { colspan: '11', class: 'muted', text: 'No cases saved yet.' })]));
  }

  function showView(name) {
    show('view-dashboard', name === 'dashboard');
    show('view-case', name === 'case');
    window.scrollTo(0, 0);
  }

  function goHome() {
    flushSave().then(function () {
      state.cur = null; state.analysis = null;
      showView('dashboard');
      refreshCases();
    });
  }

  // ============================================================== CASES
  function blankCase() {
    return { firNo: '', firDate: '', policeStation: '', sections: '', complainant: '', periodFrom: '', periodTo: '',
      firCopyId: null, firCopyName: '', export: null, txnMap: null, selected: null, extraIdentifiers: [], idDeselected: {},
      assignments: {}, requested: {}, notices: [], seq: 0, ackList: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }

  var CASE_FIELDS = ['firNo', 'firDate', 'policeStation', 'sections', 'complainant', 'periodFrom', 'periodTo'];

  function openCase(firNo, scrollTo) {
    flushSave().then(function () { return firNo ? S.get('cases', firNo) : null; }).then(function (c) {
      state.cur = c || blankCase();
      state.txnWorkbooks = {};
      state.analysis = null;
      state.sort = { key: 'rank', dir: 1 };
      CASE_FIELDS.forEach(function (k) { $('c-' + k).value = state.cur[k] || ''; });
      $('g-date').value = B.formatDate(new Date());
      $('g-days').value = String(load(KEYS.replyDays, 7));
      ['f-text', 'f-min'].forEach(function (id) { $(id).value = ''; });
      $('f-repeated').checked = false; $('f-match').value = '';
      $('save-status').textContent = c ? 'Saved' : 'Not saved yet — enter the FIR number';
      showView('case');
      renderCaseHeader();
      renderFirFile();
      renderUpload();
      if (state.cur.export && state.cur.txnMap) runAnalysis(true);
      else ['step-results', 'step-identifiers', 'step-banks', 'step-generate'].forEach(function (id) { show(id, false); });
      renderChecklist();
      if (scrollTo) setTimeout(function () { $(scrollTo).scrollIntoView({ block: 'start' }); }, 50);
    });
  }

  function renderCaseHeader() {
    $('case-title').textContent = state.cur.firNo ? 'FIR ' + state.cur.firNo + (state.cur.policeStation ? ' — ' + state.cur.policeStation : '') : 'New case';
  }

  // Debounced save of the open case.
  var saveTimer = null, savePending = null;
  function scheduleSave() {
    if (!state.cur || !state.cur.firNo) { $('save-status').textContent = 'Not saved yet — enter the FIR number'; return; }
    $('save-status').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 400);
  }
  function doSave() {
    saveTimer = null;
    var c = state.cur;
    if (!c || !c.firNo) return Promise.resolve();
    c.updatedAt = new Date().toISOString();
    c.ackList = state.analysis ? state.analysis.stats.acks : (c.ackList || []);
    savePending = S.put('cases', c).then(function () {
      $('save-status').textContent = S.persistent ? 'Saved ' + new Date().toLocaleTimeString() : 'Kept in memory only (browser storage unavailable) — use Backup';
    }).catch(function (e) { $('save-status').textContent = 'Save failed: ' + e.message; });
    return savePending;
  }
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); return doSave(); }
    return savePending || Promise.resolve();
  }

  function onCaseField(k) {
    var input = $('c-' + k), v = input.value.trim();
    if (k !== 'firNo') { state.cur[k] = v; afterCaseChange(); return; }
    var old = state.cur.firNo;
    if (v === old) return;
    if (!v) { input.value = old; prompt('FIR number is mandatory', 'The case is stored against the FIR number, so it cannot be blank.'); return; }
    S.get('cases', v).then(function (other) {
      if (other) { input.value = old; prompt('FIR number already exists', 'A case with FIR number ' + v + ' is already saved. Open it from the Cases list instead.'); return; }
      var rename = old ? S.del('cases', old) : Promise.resolve();
      return rename.then(function () {
        state.cur.firNo = v;
        return reassignFiles(old, v);
      }).then(function () { afterCaseChange(); toast(old ? 'FIR number changed' : 'Case saved under FIR ' + v); });
    });
  }

  function reassignFiles(oldFir, newFir) {
    if (!oldFir) return Promise.resolve();
    return S.getAll('files').then(function (files) {
      return Promise.all(files.filter(function (f) { return f.firNo === oldFir; }).map(function (f) { f.firNo = newFir; return S.put('files', f); }));
    });
  }

  function afterCaseChange() {
    renderCaseHeader();
    renderChecklist();
    if (state.analysis) renderRecipients();
    scheduleSave();
  }

  function renderChecklist() {
    var list = caseChecks(state.cur, state.analysis, state.recipients);
    var ul = clear($('checklist'));
    var labels = [['firNo', 'FIR number'], ['firDate', 'FIR date'], ['policeStation', 'Police station'], ['sections', 'Sections of law'],
      ['firCopy', 'FIR copy'], ['export', 'NCRP transaction export'], ['officer', 'Officer name & designation'], ['officerEmail', 'Officer e-mail']];
    var missingFields = {};
    list.forEach(function (x) { missingFields[x.field] = x; });
    labels.forEach(function (l) {
      var miss = missingFields[l[0]];
      ul.appendChild(el('li', { class: miss ? 'miss' : 'okay' }, [miss ? '✗ ' : '✓ ', l[1]]));
    });
    list.filter(function (x) { return !labels.some(function (l) { return l[0] === x.field; }); }).forEach(function (x) {
      ul.appendChild(el('li', { class: x.level === 'missing' ? 'miss' : 'warnitem' }, [(x.level === 'missing' ? '✗ ' : '! ') + x.message]));
    });
    CASE_FIELDS.slice(0, 4).forEach(function (k) { $('c-' + k).classList.toggle('invalid', !!missingFields[k]); });
    return list;
  }

  // ---------------------------------------------------------------- FIR copy
  function handleFirFile(files) {
    var f = files && files[0];
    if (!f) return;
    if (!state.cur.firNo) { prompt('Enter the FIR number first', 'The FIR copy is stored against the FIR number.'); return; }
    if (f.size > 15 * 1024 * 1024) toast('Warning: FIR copy is over 15 MB — many mail servers reject large attachments');
    fileBytes(f).then(function (bytes) {
      var ext = (f.name.match(/\.[A-Za-z0-9]+$/) || ['.pdf'])[0].toLowerCase();
      var rec = { id: state.cur.firCopyId || newId('fir'), firNo: state.cur.firNo, kind: 'fir', name: 'FIR_Copy_' + B.safeFileName(state.cur.firNo) + ext,
        originalName: f.name, type: f.type || 'application/pdf', size: f.size, data: bytes, addedAt: new Date().toISOString() };
      return S.put('files', rec).then(function () {
        state.cur.firCopyId = rec.id; state.cur.firCopyName = rec.name;
        renderFirFile(); afterCaseChange(); toast('FIR copy saved');
      });
    });
  }

  function renderFirFile() {
    var box = clear($('fir-file'));
    if (!state.cur.firCopyId) return;
    box.appendChild(document.createTextNode(state.cur.firCopyName + ' '));
    box.appendChild(el('button', { type: 'button', class: 'btn btn-small', text: 'Open', onclick: function (e) {
      e.preventDefault(); e.stopPropagation();
      S.get('files', state.cur.firCopyId).then(function (f) { if (f) download(new Blob([f.data], { type: f.type }), f.name); });
    } }));
  }

  function firCopy() {
    if (!state.cur.firCopyId) return Promise.resolve(null);
    return S.get('files', state.cur.firCopyId).then(function (f) { return f ? { name: f.name, type: f.type, data: f.data } : null; });
  }

  // ============================================================ UPLOAD
  function handleTxnFiles(files) {
    clear($('upload-errors'));
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    Promise.all(list.map(function (f) { return loadFileEntry(f, B.TXN_FIELDS); })).then(function (entries) {
      state.txnWorkbooks = {};
      entries.forEach(function (e) { state.txnWorkbooks[e.name] = e.wb; });
      state.cur.export = { files: entries.map(function (e) { return { name: e.name, sheet: e.sheet, headers: e.table.headers, rows: e.table.rows, headerRow: e.table.headerRow }; }), loadedAt: new Date().toISOString() };
      state.cur.txnMap = B.guessMapping(txnHeaders(), B.TXN_FIELDS, load(KEYS.txnMap, null));
      state.cur.selected = null;
      state.analysis = null;
      ['step-results', 'step-identifiers', 'step-banks', 'step-generate'].forEach(function (id) { show(id, false); });
      renderUpload();
      afterCaseChange();
    }).catch(function (err) {
      $('upload-errors').appendChild(el('div', { class: 'alert alert-bad', text: 'Could not read the file: ' + (err && err.message || err) }));
    });
  }

  function txnFiles() { return (state.cur.export && state.cur.export.files) || []; }

  function txnHeaders() {
    var seen = {}, out = [];
    txnFiles().forEach(function (f) { f.headers.forEach(function (h) { if (!seen[h]) { seen[h] = 1; out.push(h); } }); });
    return out;
  }

  function txnRows() {
    var files = txnFiles(), multi = files.length > 1, rows = [];
    files.forEach(function (f) {
      f.rows.forEach(function (r) {
        var copy = Object.assign({}, r);
        copy.__row = multi ? f.name + ':' + r.__row : r.__row;
        rows.push(copy);
      });
    });
    return rows;
  }

  function renderUpload() {
    var files = txnFiles();
    $('txn-files').textContent = files.map(function (f) { return f.name + ' (' + f.rows.length + ' rows)'; }).join(', ');
    show('mapping-box', files.length > 0);
    if (!files.length) return;
    var entries = files.map(function (f) {
      return { name: f.name, wb: state.txnWorkbooks[f.name], sheet: f.sheet, table: { headers: f.headers, rows: f.rows } };
    });
    sheetPicker($('txn-sheets'), entries, B.TXN_FIELDS, function (entry) {
      var f = files.filter(function (x) { return x.name === entry.name; })[0];
      f.sheet = entry.sheet; f.headers = entry.table.headers; f.rows = entry.table.rows; f.headerRow = entry.table.headerRow;
      state.cur.txnMap = B.guessMapping(txnHeaders(), B.TXN_FIELDS, load(KEYS.txnMap, null));
      renderUpload(); scheduleSave();
    });
    mappingTable($('txn-map'), B.TXN_FIELDS, txnHeaders(), state.cur.txnMap, function () { renderUpload(); scheduleSave(); });
    renderPreview();
    $('map-errors').textContent = '';
  }

  function renderPreview() {
    var t = clear($('txn-preview'));
    var headers = txnHeaders(), rows = txnRows().slice(0, 8);
    t.appendChild(el('tr', null, headers.map(function (h) { return el('th', { text: h }); })));
    rows.forEach(function (r) {
      t.appendChild(el('tr', null, headers.map(function (h) {
        var v = r[h]; return el('td', { text: v instanceof Date ? B.formatDate(v) : String(v == null ? '' : v) });
      })));
    });
  }

  // ========================================================== ANALYSIS
  function runAnalysis(silent) {
    var map = state.cur.txnMap || {};
    var missing = B.TXN_FIELDS.filter(function (f) { return f.required && !map[f.key]; }).map(function (f) { return f.label; });
    if (!txnFiles().length) { $('map-errors').textContent = 'Upload the NCRP transaction export first.'; return; }
    if (missing.length) { $('map-errors').textContent = 'Map required column(s): ' + missing.join(', '); return; }
    save(KEYS.txnMap, map);

    var rows = txnRows();
    state.analysis = B.analyse(rows, map, { layer: 1 });
    state.analysis.accounts.forEach(function (a, i) { a.rank = i + 1; });
    if (!state.cur.selected) {
      state.cur.selected = {};
      state.analysis.accounts.forEach(function (a) { state.cur.selected[a.account] = true; });
    }
    state.rawRows = rows;
    recompute();
    ['step-results', 'step-identifiers', 'step-banks', 'step-generate'].forEach(function (id) { show(id, true); });
    if (!silent) { scheduleSave(); $('step-results').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  /** Re-derive matches, identifiers and recipients after any change. */
  function recompute() {
    state.analysis.accounts.forEach(function (a) { a.match = B.matchBank(a.bank, a.ifsc, state.directory, state.overrides); });
    state.identifiers = B.extractIdentifiers(state.rawRows || txnRows(), state.cur.txnMap, state.cur.extraIdentifiers);
    state.identifiers.forEach(function (it) {
      it.selected = !state.cur.idDeselected[it.key];
      it.match = B.matchIdentifier(it, state.directory, state.cur.assignments);
    });
    renderResults();
    renderIdentifiers();
  }

  // ------------------------------------------------------------ results
  var COLS = [
    { key: 'sel', label: '' }, { key: 'rank', label: '#', num: true }, { key: 'account', label: 'Account No' },
    { key: 'bank', label: 'Bank' }, { key: 'match', label: 'Nodal match' }, { key: 'ifsc', label: 'IFSC' },
    { key: 'ackCount', label: 'Ack nos', num: true }, { key: 'acks', label: 'Ack numbers' },
    { key: 'disputedPaise', label: 'Disputed ₹', num: true }, { key: 'txnCount', label: 'Txns', num: true }
  ];

  function filteredAccounts() {
    var q = $('f-text').value.trim().toLowerCase(), rep = $('f-repeated').checked, min = parseFloat($('f-min').value), mf = $('f-match').value;
    var sel = state.cur.selected;
    var list = state.analysis.accounts.filter(function (a) {
      if (rep && a.ackCount < 2) return false;
      if (!isNaN(min) && a.disputedPaise < min * 100) return false;
      if (mf === 'matched' && !a.match.entry) return false;
      if (mf === 'unmatched' && a.match.entry) return false;
      if (q && [a.account, a.bank, a.ifsc, a.acks.join(' '), a.match.entry ? a.match.entry.bank : ''].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var k = state.sort.key, d = state.sort.dir;
    var val = function (x) { return k === 'match' ? (x.match.entry ? x.match.entry.bank : '') : k === 'acks' ? x.acks.join(',') : k === 'sel' ? (sel[x.account] ? 1 : 0) : x[k]; };
    list.sort(function (x, y) {
      var a = val(x), b = val(y);
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * d || x.rank - y.rank;
      return String(a).localeCompare(String(b), undefined, { numeric: true }) * d || x.rank - y.rank;
    });
    return list;
  }

  function matchBadge(m) {
    if (!m.entry) return badge('unmatched', 'bad');
    var label = { ifsc: 'IFSC', name: 'name', manual: 'manual', domain: 'domain' }[m.method] || m.method;
    return el('span', null, [m.entry.bank + ' ', m.entry.emails.length ? badge(label, 'ok') : badge('no e-mail', 'warn')]);
  }

  function renderStats() {
    var s = state.analysis.stats;
    var tiles = [
      [s.totalRows, 'transaction rows'], [s.ackCount, 'Ack numbers'], ['₹ ' + inr(s.totalLossPaise), 'total loss (Layer 1 disputed)'],
      [s.holdMapped ? '₹ ' + inr(s.totalHoldPaise) : '—', s.holdMapped ? 'put on hold' : 'put on hold (column not mapped)'],
      [s.accountCount, 'Layer 1 accounts'], [s.repeatedCount, 'repeated across Acks']
    ];
    var box = clear($('stats'));
    tiles.forEach(function (t) { box.appendChild(el('div', { class: 'tile' }, [el('div', { class: 'v', text: String(t[0]) }), el('div', { class: 'k', text: t[1] })])); });
    var w = clear($('warnings'));
    state.analysis.warnings.forEach(function (msg) { w.appendChild(el('li', { text: msg })); });
    if (!state.directory.length) w.appendChild(el('li', { text: 'No nodal officers directory loaded — upload it on the Cases page so e-mail IDs can be matched.' }));

    var t = clear($('ack-summary'));
    t.appendChild(el('tr', null, ['Ack No', 'Total loss ₹ (Layer 1 disputed)', 'Put on hold ₹', 'Layers', 'Layer 1 accounts', 'Rows'].map(function (h, i) { return el('th', { class: i && i < 3 || i > 3 ? 'num' : '', text: h }); })));
    state.analysis.ackSummary.forEach(function (a) {
      t.appendChild(el('tr', null, [el('td', { class: 'mono', text: a.ack }), el('td', { class: 'num', text: inr(a.lossPaise) }),
        el('td', { class: 'num', text: s.holdMapped ? inr(a.holdPaise) : '—' }), el('td', { text: a.layers.join(', ') }),
        el('td', { class: 'num', text: String(a.l1AccountCount) }), el('td', { class: 'num', text: String(a.rowCount) })]));
    });
  }

  function renderResults() {
    renderStats();
    var table = clear($('results')), list = filteredAccounts(), sel = state.cur.selected;
    var head = el('tr', null, COLS.map(function (c) {
      if (c.key === 'sel') {
        var all = el('input', { type: 'checkbox', 'aria-label': 'Select all shown', onchange: function () { setSelection(list, all.checked); } });
        all.checked = list.length > 0 && list.every(function (a) { return sel[a.account]; });
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
      var tr;
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Select ' + a.account, onchange: function () {
        if (cb.checked) sel[a.account] = true; else delete sel[a.account];
        tr.classList.toggle('selected', cb.checked); selectionChanged();
      } });
      cb.checked = !!sel[a.account];
      tr = el('tr', { class: (cb.checked ? 'selected ' : '') + (a.match.entry ? '' : 'unmatched') }, [
        el('td', null, [cb]), el('td', { class: 'num', text: String(a.rank) }),
        el('td', { class: 'mono', text: a.account, title: a.warning || null }, a.warning ? [badge('!', 'warn')] : []),
        el('td', { text: a.bank, title: a.bankVariants.join(' | ') }), el('td', null, [matchBadge(a.match)]),
        el('td', { class: 'mono', text: a.ifsc }), el('td', { class: 'num', text: String(a.ackCount) }),
        el('td', { class: 'acks', text: a.acks.join(', ') }), el('td', { class: 'num', text: inr(a.disputedPaise) }),
        el('td', { class: 'num', text: String(a.txnCount) })
      ]);
      body.appendChild(tr);
    });
    if (!list.length) body.appendChild(el('tr', null, [el('td', { colspan: String(COLS.length), class: 'muted', text: 'No accounts match the filter.' })]));
    table.appendChild(body);
    selectionChanged(true);
  }

  function setSelection(list, on) {
    list.forEach(function (a) { if (on) state.cur.selected[a.account] = true; else delete state.cur.selected[a.account]; });
    renderResults(); scheduleSave();
  }

  function selectedAccounts() { return state.analysis.accounts.filter(function (a) { return state.cur.selected[a.account]; }); }

  function selectionChanged(noSave) {
    var sel = selectedAccounts();
    var total = sel.reduce(function (s, a) { return s + a.disputedPaise; }, 0);
    $('sel-summary').textContent = sel.length + ' of ' + state.analysis.accounts.length + ' accounts selected · ₹ ' + inr(total) + ' disputed';
    renderRecipients();
    if (!noSave) scheduleSave();
  }

  // -------------------------------------------------------- identifiers
  function renderIdentifiers() {
    var t = clear($('identifiers'));
    t.appendChild(el('tr', null, ['', 'Identifier', 'Type', 'Ack nos', 'Source', 'Recipient (nodal officer)', ''].map(function (h) { return el('th', { text: h }); })));
    state.identifiers.forEach(function (it) {
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Select ' + it.value, onchange: function () {
        if (cb.checked) delete state.cur.idDeselected[it.key]; else state.cur.idDeselected[it.key] = true;
        it.selected = cb.checked; renderRecipients(); scheduleSave();
      } });
      cb.checked = it.selected;
      var cats = it.type === 'phone' ? ['telecom'] : it.type === 'upi' ? ['payment', 'bank'] : ['platform', 'telecom', 'payment', 'bank'];
      var current = it.match.entry ? it.match.entry.bank : '';
      var sel = el('select', { 'aria-label': 'Recipient for ' + it.value, onchange: function () {
        if (sel.value) state.cur.assignments[it.key] = sel.value; else delete state.cur.assignments[it.key];
        it.match = B.matchIdentifier(it, state.directory, state.cur.assignments);
        renderIdentifiers(); renderRecipients(); scheduleSave();
      } }, directoryOptions(current, cats, it.type === 'phone' ? '— choose operator (TSP) —' : '— choose platform —'));
      var removable = it.sources.length === 1 && it.sources[0] === 'manual';
      t.appendChild(el('tr', { class: it.selected && !it.match.entry ? 'unmatched' : '' }, [
        el('td', null, [cb]),
        el('td', { class: 'mono wrap', text: it.value }, it.warning ? [' ', el('span', { class: 'badge badge-warn', title: it.warning, text: '!' })] : []),
        el('td', { text: B.ID_TYPES[it.type] }), el('td', { class: 'acks', text: it.acks.join(', ') || '—' }),
        el('td', { text: it.sources.join(', ') }),
        el('td', null, [sel, ' ', it.match.entry ? badge(it.match.method, 'ok') : badge('unassigned', 'bad')]),
        el('td', null, [removable ? el('button', { type: 'button', class: 'btn btn-small', text: 'Remove', onclick: function () {
          state.cur.extraIdentifiers = state.cur.extraIdentifiers.filter(function (x) { var c = B.classifyIdentifier(x.value, x.hint); return !c || c.key !== it.key; });
          recompute(); scheduleSave();
        } }) : null])
      ]));
    });
    if (!state.identifiers.length) t.appendChild(el('tr', null, [el('td', { colspan: '7', class: 'muted', text: 'None found. Map the suspect mobile / URL / social media columns in step 2, or add them above.' })]));
    clear($('bulk-tsp'));
    directoryOptions('', ['telecom'], '— operator —').forEach(function (o) { $('bulk-tsp').appendChild(o); });
  }

  function addIdentifiers() {
    var hint = $('id-add-hint').value;
    var acks = $('id-add-acks').value.split(/[\s,;]+/).map(function (a) { return B.normId(a).value; }).filter(Boolean);
    var values = B.splitIdentifiers($('id-add').value);
    var added = 0;
    values.forEach(function (v) {
      if (B.classifyIdentifier(v, hint)) { state.cur.extraIdentifiers.push({ value: v, hint: hint, acks: acks }); added++; }
    });
    $('id-add').value = '';
    recompute(); scheduleSave();
    toast(added + ' identifier(s) added');
  }

  function bulkAssignTsp() {
    var tsp = $('bulk-tsp').value;
    if (!tsp) { toast('Choose an operator first'); return; }
    var n = 0;
    state.identifiers.forEach(function (it) { if (it.type === 'phone' && !it.match.entry) { state.cur.assignments[it.key] = tsp; n++; } });
    recompute(); scheduleSave();
    toast(n + ' mobile number(s) assigned to ' + tsp);
  }

  // --------------------------------------------------------- recipients
  /** Merge bank groups (accounts) and identifier groups into one list of notice recipients. */
  function computeRecipients() {
    var bankRes = B.groupByBank(selectedAccounts(), state.directory, state.overrides);
    var idGroups = B.groupIdentifiers(state.identifiers.filter(function (i) { return i.selected; }), state.directory, state.cur.assignments);
    var byKey = {}, list = [];
    bankRes.groups.concat(idGroups).forEach(function (g) {
      var k = g.entry ? stableKey(g) : (g.items && g.items.length ? 'UI:' + g.key : g.key);
      var m = byKey[k];
      if (!m) {
        m = byKey[k] = Object.assign({}, g, { stableKey: k, accounts: (g.accounts || []).slice(), items: (g.items || []).slice(), methods: Object.assign({}, g.methods), rawNames: (g.rawNames || []).slice(), acks: g.acks.slice() });
        list.push(m);
      } else {
        m.accounts = m.accounts.concat(g.accounts || []);
        m.items = m.items.concat(g.items || []);
        Object.assign(m.methods, g.methods);
        g.acks.forEach(function (a) { if (m.acks.indexOf(a) < 0) m.acks.push(a); });
        m.acks.sort();
        m.disputedPaise += g.disputedPaise || 0;
      }
    });
    list.forEach(function (g) {
      if (!g.emails.length) {
        var manual = state.manualEmails[g.entry ? 'N:' + B.normBankName(g.entry.bank) : g.normName];
        if (manual && manual.length) { g.emails = manual.slice(); g.manualEmails = true; }
      }
      g.requested = state.cur.requested[g.stableKey] || T.defaultRequested(g.kind);
      var existing = (state.cur.notices || []).filter(function (n) { return n.recipientKey === g.stableKey; })[0];
      g.noticeRef = existing ? existing.ref : null;
      g.notice = existing || null;
    });
    // Unassigned identifiers cannot get a notice until a recipient is chosen.
    state.recipients = list;
    state.unmatched = list.filter(function (g) { return !g.entry || !g.emails.length; });
    var settings = currentSettings();
    O.assignFileNames(list, settings);
    return list;
  }

  function sendable(g) { return !!(g.entry || (g.accounts && g.accounts.length)); }

  function renderRecipients() {
    if (!state.analysis) return;
    var list = computeRecipients();
    var box = clear($('unmatched-box'));
    var problems = state.unmatched.length;
    if (problems) {
      box.appendChild(el('div', { class: 'alert alert-bad' }, [el('strong', { text: problems + ' recipient(s) need attention. ' }),
        'Choose the right nodal officer or type the e-mail ID(s). Bank fixes are remembered for future cases.']));
    } else if (list.length) {
      box.appendChild(el('div', { class: 'alert alert-ok', text: 'All ' + list.length + ' recipient(s) matched to nodal e-mail IDs.' }));
    }
    var t = clear($('banks'));
    t.appendChild(el('tr', null, ['Recipient', 'Category', 'Match', 'Accounts', 'Identifiers', 'Nodal e-mail(s)', 'Documents requested', 'Fix'].map(function (h) { return el('th', { text: h }); })));
    list.forEach(function (g) {
      var fix = (!g.entry || g.method === 'manual' || !g.emails.length) ? fixControls(g) : null;
      t.appendChild(el('tr', { class: g.entry && g.emails.length ? '' : 'unmatched' }, [
        el('td', null, [g.entry ? g.bankName : badge('UNMATCHED', 'bad'), g.entry ? null : el('div', { class: 'small', text: (g.rawNames || []).join('; ') || g.bankName })]),
        el('td', { text: B.CATEGORIES[g.kind] || 'Unassigned' }),
        el('td', { text: O.methodText(g) }),
        el('td', { class: 'num', text: String(g.accounts.length) }),
        el('td', { class: 'num', text: String(g.items.length) }),
        el('td', { class: 'wrap', text: g.emails.join('; ') || '—' }),
        el('td', null, [requestControls(g)]),
        el('td', null, [fix])
      ]));
    });
    if (!list.length) t.appendChild(el('tr', null, [el('td', { colspan: '8', class: 'muted', text: 'No accounts or identifiers selected.' })]));
    renderEmails();
    renderRegister();
    renderChecklist();
  }

  function requestControls(g) {
    var wrap = el('div', { class: 'reqs' });
    var more = el('details', { class: 'reqmore' }, [el('summary', { text: 'more…' })]);
    T.REQUEST_ITEMS.forEach(function (r) {
      var cb = el('input', { type: 'checkbox', onchange: function () {
        var ids = (state.cur.requested[g.stableKey] || g.requested).slice();
        if (cb.checked && ids.indexOf(r.id) < 0) ids.push(r.id);
        if (!cb.checked) ids = ids.filter(function (x) { return x !== r.id; });
        state.cur.requested[g.stableKey] = ids;
        renderRecipients(); scheduleSave();
      } });
      cb.checked = g.requested.indexOf(r.id) >= 0;
      var relevant = r.cats.indexOf(g.kind) >= 0 || cb.checked;
      (relevant ? wrap : more).appendChild(el('label', { class: 'reqchip', title: r.label }, [cb, ' ' + r.short]));
    });
    if (more.children.length > 1) wrap.appendChild(more);
    return wrap;
  }

  function fixControls(g) {
    var wrap = el('div', { class: 'fix' });
    if (g.accounts.length && (!g.entry || g.method === 'manual')) {
      var nameKeys = {};
      (g.rawNames || []).forEach(function (n) { nameKeys[B.normBankName(n)] = true; });
      if (!(g.rawNames || []).length) nameKeys[g.normName] = true;
      var current = Object.keys(nameKeys).map(function (k) { return state.overrides[k]; }).filter(Boolean)[0] || '';
      var sel = el('select', { 'aria-label': 'Assign nodal bank', onchange: function () {
        Object.keys(nameKeys).forEach(function (k) { if (sel.value) state.overrides[k] = sel.value; else delete state.overrides[k]; });
        save(KEYS.overrides, state.overrides);
        recompute();
      } }, directoryOptions(current, ['bank', 'payment'], g.suggestion ? '— choose (closest: ' + g.suggestion.bank + ') —' : '— choose nodal bank —'));
      wrap.appendChild(sel);
    } else if (!g.entry && g.items.length) {
      wrap.appendChild(el('span', { class: 'small', text: 'Choose a recipient for each identifier in step 4.' }));
    }
    if (g.entry && (!g.emails.length || g.manualEmails) || !g.entry && g.accounts.length) {
      var key = g.entry ? 'N:' + B.normBankName(g.entry.bank) : g.normName;
      var input = el('input', { type: 'text', placeholder: 'e-mail(s), comma separated', 'aria-label': 'Manual e-mail IDs', value: (state.manualEmails[key] || []).join(', ') });
      var btn = el('button', { type: 'button', class: 'btn btn-small', text: 'Use', onclick: function () {
        var emails = B.extractEmails(input.value);
        if (emails.length) state.manualEmails[key] = emails; else delete state.manualEmails[key];
        save(KEYS.emails, state.manualEmails);
        renderRecipients();
      } });
      wrap.appendChild(el('div', null, [input, ' ', btn]));
    }
    return wrap;
  }

  // ========================================================== GENERATE
  function currentSettings() {
    var s = Object.assign({}, state.settings);
    s.caseRef = state.cur && state.cur.firNo || '';
    s.noticeDate = $('g-date').value.trim() || B.formatDate(new Date());
    s.replyDays = parseInt($('g-days').value, 10) || 7;
    return s;
  }

  function caseInfo() {
    var c = state.cur, st = state.analysis && state.analysis.stats;
    return { firNo: c.firNo, firDate: c.firDate, policeStation: c.policeStation, sections: c.sections, periodFrom: c.periodFrom, periodTo: c.periodTo,
      totalLossPaise: st ? st.totalLossPaise : 0, holdPaise: st ? st.totalHoldPaise : 0 };
  }

  /** Give each sendable recipient a stable notice reference and record it in the case. */
  function ensureNotices(groups) {
    var c = state.cur, now = new Date().toISOString();
    groups.forEach(function (g) {
      var n = c.notices.filter(function (x) { return x.recipientKey === g.stableKey; })[0];
      if (!n) {
        c.seq = (c.seq || 0) + 1;
        n = { ref: M.noticeRef(c.firNo, c.seq), recipientKey: g.stableKey, status: 'generated', replies: [], createdAt: now };
        c.notices.push(n);
      }
      Object.assign(n, { recipientName: g.bankName, kind: g.kind, emails: g.emails.slice(), fileName: g.fileName, emlName: g.emlName,
        accountCount: g.accounts.length, itemCount: g.items.length, requested: g.requested.slice(), acks: g.acks.slice(), generatedAt: now });
      g.noticeRef = n.ref; g.notice = n;
    });
    scheduleSave();
  }

  function preflight(groups) {
    if (!state.cur.firNo) { prompt('FIR number is mandatory', 'Enter the FIR number in step 1 — notices and replies are stored against it.'); return false; }
    var missing = renderChecklist().filter(function (x) { return x.level === 'missing'; });
    if (missing.length && !window.confirm('These mandatory items are missing for FIR ' + state.cur.firNo + ':\n\n• ' + missing.map(function (m) { return m.message; }).join('\n• ') + '\n\nGenerate anyway?')) return false;
    var unknown = B.unknownPlaceholders(state.templates.notice + '\n' + state.templates.subject + '\n' + state.templates.body);
    if (unknown.length && !window.confirm('The templates have unknown placeholder(s): ' + unknown.join(', ') + '. They will be left as-is. Continue?')) return false;
    if (!groups.length) { prompt('Nothing to generate', 'Select at least one account or assign a recipient to an identifier.'); return false; }
    return true;
  }

  function buildContext() {
    computeRecipients();
    var groups = state.recipients.filter(sendable);
    state.analysis.accounts.forEach(function (a) { a.selected = !!state.cur.selected[a.account]; });
    return firCopy().then(function (fc) {
      return { analysis: state.analysis, accounts: state.analysis.accounts, groups: groups, unmatched: state.unmatched,
        settings: currentSettings(), caseInfo: caseInfo(), identifiers: state.identifiers, firCopy: fc };
    });
  }

  function stamp() { var d = new Date(); return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2); }

  function downloadZip() {
    computeRecipients();
    var groups = state.recipients.filter(sendable);
    if (!preflight(groups)) return;
    ensureNotices(groups);
    var status = $('gen-status');
    status.textContent = 'Building ' + groups.length + ' notice(s)…';
    $('btn-zip').disabled = true;
    buildContext().then(function (ctx) {
      ctx.groups.forEach(function (g) { var n = state.cur.notices.filter(function (x) { return x.recipientKey === g.stableKey; })[0]; if (n) g.noticeRef = n.ref; });
      return O.bundleZip(ctx, state.templates).then(function (blob) {
        download(blob, 'BNSS94_' + B.safeFileName(state.cur.firNo) + '_' + stamp() + '.zip');
        status.textContent = 'Done: ' + ctx.groups.length + ' notice(s)' + (ctx.unmatched.length ? ' — ' + ctx.unmatched.length + ' recipient(s) still need attention.' : '.');
        renderRecipients();
      });
    }).catch(function (e) { status.textContent = 'Failed: ' + e.message; })
      .then(function () { $('btn-zip').disabled = false; });
  }

  function downloadXlsx() {
    buildContext().then(function (ctx) {
      download(O.summaryXlsx(ctx), 'BNSS94_Summary_' + B.safeFileName(state.cur.firNo || 'case') + '_' + stamp() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    });
  }

  function downloadOne(g, kind) {
    if (!preflight([g])) return;
    ensureNotices([g]);
    var s = currentSettings(), ci = caseInfo();
    O.noticeDocx(g, state.templates, s, ci).then(function (data) {
      if (kind === 'docx') { download(data, g.fileName); return; }
      return Promise.all([O.bytesOf(data), firCopy()]).then(function (r) {
        var eml = O.noticeEml(g, r[0], { settings: s, caseInfo: ci, firCopy: r[1] }, state.templates);
        download(new Blob([eml], { type: 'message/rfc822' }), g.emlName);
      });
    }).then(renderRecipients);
  }

  function renderEmails() {
    var t = clear($('emails'));
    t.appendChild(el('tr', null, ['Recipient', 'Notice ref', 'Nodal e-mail(s)', 'Attachment', 'Items', ''].map(function (h) { return el('th', { text: h }); })));
    state.recipients.filter(sendable).forEach(function (g) {
      var emails = g.emails.join('; ');
      t.appendChild(el('tr', { class: g.emails.length ? '' : 'unmatched' }, [
        el('td', { text: g.bankName }),
        el('td', { class: 'mono', text: g.noticeRef || '(new)' }),
        el('td', { class: 'wrap', text: emails || 'NOT FOUND' }),
        el('td', { class: 'mono', text: g.fileName }),
        el('td', { class: 'num', text: String(g.accounts.length + g.items.length) }),
        el('td', { class: 'nowrap' }, [
          el('button', { type: 'button', class: 'btn btn-small', text: 'Preview', onclick: function () { previewNotice(g); } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: '.docx', onclick: function () { downloadOne(g, 'docx'); } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small btn-send', text: g.notice && g.notice.sentAt ? 'Send again' : 'Send',
            title: mailReady() ? 'Send this notice by e-mail now' : 'Set up the mail helper under “Mail” to send directly',
            disabled: !emails || !mailReady() || mail.sending, onclick: function () { sendNotices([g]); } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'E-mail draft', disabled: !emails, onclick: function () { downloadOne(g, 'eml'); } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Copy e-mails', disabled: !emails, onclick: function () { copyText(emails); } })
        ])
      ]));
    });
    var none = !state.recipients.filter(sendable).length;
    $('btn-zip').disabled = none; $('btn-xlsx').disabled = !state.analysis; $('btn-copy-tsv').disabled = none;
    $('btn-send-all').disabled = none || !mailReady() || mail.sending;
  }

  // ------------------------------------------------------------- register
  var STATUSES = [['generated', 'Generated'], ['sent', 'Sent'], ['replied', 'Reply received'], ['partial', 'Partial reply'], ['closed', 'Closed']];

  function setStatus(n, status) {
    n.status = status;
    if (status === 'sent' && !n.sentAt) {
      n.sentAt = new Date().toISOString();
      var days = parseInt($('g-days').value, 10) || 7;
      save(KEYS.replyDays, days);
      n.dueAt = new Date(Date.now() + days * 864e5).toISOString();
    }
    scheduleSave();
    setTimeout(syncWatch, 600);
  }

  function renderRegister() {
    var c = state.cur, t = clear($('register'));
    t.appendChild(el('tr', null, ['Ref', 'Recipient', 'Status', 'Sent', 'Reply due', 'Replies', ''].map(function (h) { return el('th', { text: h }); })));
    var now = Date.now();
    (c.notices || []).forEach(function (n) {
      var sel = el('select', { 'aria-label': 'Status of ' + n.ref, onchange: function () { setStatus(n, sel.value); renderRegister(); } },
        STATUSES.map(function (s) { return el('option', { value: s[0], text: s[1], selected: n.status === s[0] }); }));
      var overdue = n.status === 'sent' && n.dueAt && Date.parse(n.dueAt) < now;
      var replies = el('div', null, (n.replies || []).map(function (r) {
        return el('div', { class: 'reply' + (r.reviewed ? '' : ' new') }, [
          (r.reviewed ? '' : '🔔 ') + fmtIso(r.at) + ' — ' + (r.from || 'added manually') + (r.subject ? ' — “' + r.subject + '”' : ''),
          el('div', null, (r.files || []).map(function (f) {
            return el('button', { type: 'button', class: 'linklike small', text: f.name + ' ', onclick: function () {
              S.get('files', f.id).then(function (rec) { if (rec) download(new Blob([rec.data], { type: rec.type }), rec.name); });
            } });
          })),
          r.reviewed ? null : el('button', { type: 'button', class: 'btn btn-small', text: 'Mark reviewed', onclick: function () { r.reviewed = true; scheduleSave(); renderRegister(); } })
        ]);
      }));
      t.appendChild(el('tr', { class: overdue ? 'unmatched' : '' }, [
        el('td', { class: 'mono', text: n.ref }), el('td', { text: n.recipientName }), el('td', null, [sel]),
        el('td', { title: n.sentTo ? 'Sent by e-mail to ' + n.sentTo.join(', ') : null }, [fmtIso(n.sentAt), n.sentVia === 'email' ? ' ' : null, n.sentVia === 'email' ? badge('e-mailed', 'ok') : null]),
        el('td', null, [fmtIso(n.dueAt), overdue ? ' ' : null, overdue ? badge('overdue', 'bad') : null]),
        el('td', null, [replies]),
        el('td', null, [el('button', { type: 'button', class: 'btn btn-small', text: 'Remove', title: 'Remove this notice from the register', onclick: function () {
          if (!window.confirm('Remove notice ' + n.ref + ' from the register? Saved replies stay in the backup only if you exported one.')) return;
          c.notices = c.notices.filter(function (x) { return x !== n; }); scheduleSave(); renderRecipients();
        } })])
      ]));
    });
    if (!(c.notices || []).length) t.appendChild(el('tr', null, [el('td', { colspan: '7', class: 'muted', text: 'No notices generated yet.' })]));
    var target = clear($('reply-manual-target'));
    target.appendChild(el('option', { value: '', text: '— choose notice —' }));
    (c.notices || []).forEach(function (n) { target.appendChild(el('option', { value: n.ref, text: n.ref + ' — ' + n.recipientName })); });
  }

  function markAllSent() {
    var n = 0;
    (state.cur.notices || []).forEach(function (x) { if (x.status === 'generated') { setStatus(x, 'sent'); n++; } });
    renderRegister(); toast(n + ' notice(s) marked as sent');
  }

  // ============================================================== REPLIES
  /**
   * Store files as reply attachments and add a reply record to the notice.
   * Resolves to false (and stores nothing) if this e-mail was already recorded.
   */
  function addReply(caseRec, notice, info, files) {
    notice.replies = notice.replies || [];
    if (info.messageId && notice.replies.some(function (r) { return r.messageId === info.messageId; })) return Promise.resolve(false);
    var stored = [];
    return Promise.all(files.map(function (f) {
      var rec = { id: newId('reply'), firNo: caseRec.firNo, kind: 'reply', ref: notice.ref, name: f.name, type: f.type || 'application/octet-stream',
        size: f.data.length, data: f.data, addedAt: new Date().toISOString() };
      stored.push({ id: rec.id, name: rec.name });
      return S.put('files', rec);
    })).then(function () {
      notice.replies.push({ at: (info.date || new Date()).toISOString(), from: info.from || '', subject: info.subject || '', method: info.method || 'manual',
        messageId: info.messageId || null, source: info.source || 'manual', files: stored, reviewed: false });
      if (notice.status === 'generated' || notice.status === 'sent') notice.status = 'replied';
      caseRec.updatedAt = new Date().toISOString();
      return S.put('cases', caseRec).then(function () { return true; });
    });
  }

  function allNotices(cases) {
    var out = [];
    cases.forEach(function (c) { (c.notices || []).forEach(function (n) { out.push({ ref: n.ref, emails: n.emails || [], status: n.status, messageId: n.messageId, _case: c, _notice: n }); }); });
    return out;
  }

  /**
   * Match reply e-mails to notices (in any case), save them and prompt.
   * @param items  [{ name, bytes, helperId? }]
   * @param source 'file' (dropped by the user) | 'mailbox' (picked up by the mail helper)
   * @returns Promise<[helperIds that were handled]>
   */
  function processReplies(items, source) {
    if (!items.length) return Promise.resolve([]);
    var handled = [], results = [];
    return flushSave().then(function () { return S.getAll('cases'); }).then(function (cases) {
      var notices = allNotices(cases);
      return items.reduce(function (p, it) {
        return p.then(function () {
          var mail = M.parseEml(it.bytes);
          var m = M.matchReply(mail, notices);
          var original = { name: (B.safeFileName(mail.subject || 'reply').slice(0, 60) || 'reply') + '.eml', type: 'message/rfc822', data: it.bytes };
          var attachments = [original].concat(mail.attachments.map(function (a) { return { name: a.name, type: a.type, data: a.data }; }));
          var info = { date: mail.date, from: mail.from, subject: mail.subject, method: m.method, messageId: mail.headers['message-id'] || null, source: source };
          if (m.notice) {
            return addReply(m.notice._case, m.notice._notice, info, attachments).then(function (added) {
              if (it.helperId) handled.push(it.helperId);
              if (added) results.push({ ok: true, n: m.notice, method: m.method, count: mail.attachments.length });
            });
          }
          // Not matched: keep it so the user can attach it to the right notice later.
          var rec = { id: newId('unmatched'), kind: 'unmatched', name: original.name, type: original.type, data: it.bytes, firNo: null,
            subject: mail.subject, from: mail.from, date: info.date ? info.date.toISOString() : null, messageId: info.messageId,
            candidates: m.candidates.map(function (x) { return x.ref; }), addedAt: new Date().toISOString(), source: source };
          return S.put('files', rec).then(function () {
            if (it.helperId) handled.push(it.helperId);
            results.push({ ok: false, mail: mail });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      var lines = [];
      results.forEach(function (r) {
        if (!r.ok) return;
        lines.push(el('span', null, ['Reply received from ' + r.n._notice.recipientName + ' for FIR ' + r.n._case.firNo + ' (' + r.n.ref + ') — ' +
          r.count + ' attachment(s) saved' + (r.method === 'sender' ? ' (matched by sender address)' : '') + '. ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Open case', onclick: function () { $('dlg-prompt').close(); openCase(r.n._case.firNo, 'step-generate'); } })]));
      });
      var bad = results.filter(function (r) { return !r.ok; }).length;
      if (bad) lines.push(bad + ' e-mail(s) could not be matched to a notice — see “Unmatched replies” on the Cases page.');
      if (lines.length) prompt(results.some(function (r) { return r.ok; }) ? 'Reply received' : 'Reply not matched', lines);
      return refreshCases();
    }).then(function () {
      if (state.cur && state.cur.firNo) {
        return S.get('cases', state.cur.firNo).then(function (c) { if (c && state.cur) { state.cur.notices = c.notices; renderRegister(); } });
      }
    }).then(function () { syncWatch(); return handled; });
  }

  function importReplies(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    Promise.all(files.map(function (f) { return fileBytes(f).then(function (b) { return { name: f.name, bytes: b }; }); }))
      .then(function (items) { return processReplies(items, 'file'); })
      .catch(function (e) { prompt('Could not read the e-mail', e.message); });
  }

  /** Replies that could not be matched automatically, stored until the user attaches or discards them. */
  function renderUnmatched() {
    return S.getAll('files').then(function (files) {
      var list = files.filter(function (f) { return f.kind === 'unmatched'; }).sort(function (a, b) { return String(b.addedAt).localeCompare(String(a.addedAt)); });
      var box = clear($('reply-results'));
      if (!list.length) return;
      box.appendChild(el('h3', { text: 'Unmatched replies (' + list.length + ')' }));
      var pool = [];
      state.cases.forEach(function (c) { (c.notices || []).forEach(function (n) { pool.push({ c: c, n: n }); }); });
      list.forEach(function (u) {
        var prefer = u.candidates || [];
        var options = pool.slice().sort(function (a, b) { return (prefer.indexOf(b.n.ref) >= 0) - (prefer.indexOf(a.n.ref) >= 0); });
        var sel = el('select', { 'aria-label': 'Notice for this reply' }, [el('option', { value: '', text: '— choose notice —' })]
          .concat(options.map(function (p, i) { return el('option', { value: String(i), text: 'FIR ' + p.c.firNo + ' · ' + p.n.ref + ' · ' + p.n.recipientName }); })));
        box.appendChild(el('div', { class: 'alert alert-warn' }, [
          '“' + (u.subject || u.name) + '” from ' + (u.from || 'unknown sender') + (u.date ? ' (' + fmtIso(u.date) + ')' : '') + '. ', sel, ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Attach to notice', onclick: function () {
            var p = options[+sel.value];
            if (!sel.value || !p) return;
            var mail = M.parseEml(u.data);
            var atts = [{ name: u.name, type: u.type, data: u.data }].concat(mail.attachments.map(function (a) { return { name: a.name, type: a.type, data: a.data }; }));
            S.get('cases', p.c.firNo).then(function (c) {
              var n = c.notices.filter(function (x) { return x.ref === p.n.ref; })[0];
              return addReply(c, n, { date: mail.date, from: mail.from, subject: mail.subject, method: 'manual', messageId: u.messageId, source: u.source }, atts);
            }).then(function () { return S.del('files', u.id); }).then(function () { toast('Reply saved to ' + p.n.ref); refreshCases(); });
          } }), ' ',
          el('button', { type: 'button', class: 'btn btn-small', text: 'Discard', onclick: function () {
            if (window.confirm('Discard this e-mail? It is not linked to any notice.')) S.del('files', u.id).then(renderUnmatched);
          } })
        ]));
      });
    });
  }

  function attachManualReply(fileList) {
    var ref = $('reply-manual-target').value;
    var files = Array.prototype.slice.call(fileList || []);
    if (!ref) { prompt('Choose the notice first', 'Select which notice these reply files belong to, then attach them.'); return; }
    var n = state.cur.notices.filter(function (x) { return x.ref === ref; })[0];
    flushSave().then(function () {
      return Promise.all(files.map(function (f) { return fileBytes(f).then(function (b) { return { name: f.name, type: f.type, data: b }; }); }));
    }).then(function (atts) {
      return addReply(state.cur, n, { from: '', subject: '', method: 'manual' }, atts);
    }).then(function () { renderRegister(); toast(files.length + ' reply file(s) saved to ' + ref); });
  }

  // ================================================================= MAIL
  // Talks to the local mail helper (mail-helper/) on 127.0.0.1 to send notices
  // and collect replies. Without it the app works as before (.eml drafts).
  var mail = { port: load(KEYS.helperPort, 8794), code: load(KEYS.helperCode, ''), status: null, online: false, sending: false };

  function helper(method, path, body) {
    return fetch('http://127.0.0.1:' + mail.port + path, {
      method: method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-BNSS-Token': mail.code },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function mailReady() { return mail.online && mail.status && mail.status.configured && mail.status.hasPassword; }

  function refreshHelper() {
    if (!mail.code) { mail.online = false; mail.status = null; renderMailBadge(); return Promise.resolve(false); }
    return helper('GET', '/status').then(function (st) {
      mail.status = st; mail.online = true; mail.error = null; renderMailBadge(); return true;
    }).catch(function (e) {
      mail.online = false; mail.status = null;
      mail.error = e.status === 401 ? 'Pairing code not accepted — check the code shown in the helper window.' : 'Mail helper is not running on this computer.';
      renderMailBadge(); return false;
    });
  }

  function renderMailBadge() {
    var b = $('mail-badge'), label, kind;
    if (!mail.code) { label = 'not set up'; kind = 'muted'; }
    else if (!mail.online) { label = 'offline'; kind = 'warn'; }
    else if (!mail.status.configured) { label = 'needs settings'; kind = 'warn'; }
    else if (!mail.status.hasPassword) { label = 'needs password'; kind = 'warn'; }
    else if (mail.status.lastError) { label = 'error'; kind = 'bad'; }
    else { label = 'connected'; kind = 'ok'; }
    b.textContent = label; b.className = 'badge badge-' + kind;
    b.title = mail.status && mail.status.lastError ? 'Last mailbox check failed: ' + mail.status.lastError : (mail.error || '');
    var ready = mailReady();
    ['btn-send-all', 'btn-check-mail'].forEach(function (id) { if ($(id)) $(id).disabled = !ready; });
    var hint = $('mail-hint');
    if (hint) hint.textContent = ready ? 'Sending as ' + mail.status.fromEmail + '. Replies are checked every ' + mail.status.pollMinutes + ' min' +
      (mail.status.lastCheck ? ' (last check ' + new Date(mail.status.lastCheck).toLocaleTimeString() + ')' : '') + '.'
      : 'To send directly and pick up replies automatically, start the mail helper and set it up under “Mail”.';
    if (state.cur && state.analysis) renderEmails();
  }

  /** Tell the helper which notices to look out for replies to. */
  var watchTimer = null;
  function syncWatch() {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(function () {
      if (!mailReady()) return;
      S.getAll('cases').then(function (cases) {
        var refs = [], emails = [], ids = [], since = null;
        allNotices(cases).forEach(function (x) {
          var n = x._notice;
          if (['sent', 'replied', 'partial'].indexOf(n.status) < 0) return;
          refs.push(n.ref);
          (n.emails || []).forEach(function (e) { if (emails.indexOf(e) < 0) emails.push(e); });
          if (n.messageId) ids.push(n.messageId);
          if (n.sentAt && (!since || n.sentAt < since)) since = n.sentAt;
        });
        return helper('POST', '/watch', { refs: refs, emails: emails, messageIds: ids, since: since });
      }).catch(function () {});
    }, 300);
  }

  /** Collect replies the helper found in the mailbox. */
  var polling = false;
  function pollReplies() {
    if (!mailReady() || polling) return Promise.resolve();
    polling = true;
    return helper('GET', '/replies').then(function (r) {
      var items = (r.replies || []).map(function (x) { return { name: x.id + '.eml', bytes: M.unbase64(x.base64), helperId: x.id }; });
      return processReplies(items, 'mailbox');
    }).then(function (ids) {
      if (ids && ids.length) return helper('POST', '/replies/ack', { ids: ids });
    }).catch(function () {}).then(function () { polling = false; });
  }

  function checkMailNow() {
    var btn = $('btn-check-mail');
    btn.disabled = true;
    return helper('POST', '/check').then(function (r) {
      toast(r.skipped ? 'Nothing to check: ' + r.skipped : 'Mailbox checked — ' + (r.found || 0) + ' new reply(ies)');
      return pollReplies();
    }).catch(function (e) { prompt('Mailbox check failed', e.message); })
      .then(refreshHelper).then(function () { btn.disabled = !mailReady(); });
  }

  // ---- mail settings dialog
  var PRESETS = {
    gmail: { smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, imap: { host: 'imap.gmail.com', port: 993, secure: true } },
    m365: { smtp: { host: 'smtp.office365.com', port: 587, secure: false }, imap: { host: 'outlook.office365.com', port: 993, secure: true } }
  };

  function openMail() {
    $('m-port').value = String(mail.port);
    $('m-code').value = mail.code;
    $('m-test-result').textContent = '';
    refreshHelper().then(fillMailForm);
    $('dlg-mail').showModal();
  }

  function fillMailForm() {
    var st = mail.status;
    $('m-conn').textContent = mail.online ? 'Connected to the mail helper on this computer.' : (mail.code ? mail.error : 'Start the mail helper (mail-helper/Start-Mail-Helper.bat), then enter the pairing code it shows.');
    $('m-conn').className = mail.online ? 'ok-text' : 'error';
    show('m-account', mail.online);
    if (!mail.online) return;
    $('m-fromName').value = st.fromName || state.settings.officerName || '';
    $('m-fromEmail').value = st.fromEmail || state.settings.officerEmail || '';
    $('m-user').value = st.user || st.fromEmail || state.settings.officerEmail || '';
    $('m-pass').value = '';
    $('m-pass').placeholder = st.hasPassword ? 'saved — leave blank to keep' : 'mailbox password / app password';
    $('m-remember').checked = !!st.rememberPassword;
    var sm = st.smtp || {}, im = st.imap || {};
    $('m-smtp-host').value = sm.host || ''; $('m-smtp-port').value = sm.port || ''; $('m-smtp-sec').value = sm.secure === false ? 'starttls' : 'tls';
    $('m-imap-host').value = im.host || ''; $('m-imap-port').value = im.port || ''; $('m-imap-sec').value = im.secure === false ? 'starttls' : 'tls';
    $('m-poll').value = String(st.pollMinutes || 5);
    $('m-sent').checked = st.saveToSent !== false;
    $('m-selfsigned').checked = sm.rejectUnauthorized === false;
  }

  function connectHelper() {
    mail.port = parseInt($('m-port').value, 10) || 8794;
    mail.code = $('m-code').value.trim().toUpperCase();
    save(KEYS.helperPort, mail.port); save(KEYS.helperCode, mail.code);
    refreshHelper().then(function () { fillMailForm(); if (mailReady()) { syncWatch(); pollReplies(); } });
  }

  function mailFormBody() {
    var sec = function (id) { return $(id).value === 'tls'; };
    var body = {
      fromName: $('m-fromName').value.trim(), fromEmail: $('m-fromEmail').value.trim(), user: $('m-user').value.trim(),
      rememberPassword: $('m-remember').checked, pollMinutes: parseInt($('m-poll').value, 10) || 5, saveToSent: $('m-sent').checked,
      smtp: { host: $('m-smtp-host').value.trim(), port: parseInt($('m-smtp-port').value, 10) || (sec('m-smtp-sec') ? 465 : 587), secure: sec('m-smtp-sec') },
      imap: { host: $('m-imap-host').value.trim(), port: parseInt($('m-imap-port').value, 10) || (sec('m-imap-sec') ? 993 : 143), secure: sec('m-imap-sec') }
    };
    body.smtp.rejectUnauthorized = body.imap.rejectUnauthorized = !$('m-selfsigned').checked;
    if ($('m-pass').value) body.pass = $('m-pass').value;
    return body;
  }

  function saveMail(thenTest) {
    var b = mailFormBody();
    var missing = [];
    if (!B.extractEmails(b.fromEmail).length) missing.push('your e-mail address');
    if (!b.user) missing.push('login');
    if (!b.smtp.host) missing.push('SMTP server');
    if (!b.imap.host) missing.push('IMAP server');
    if (missing.length) { $('m-test-result').textContent = 'Please fill in: ' + missing.join(', '); return Promise.resolve(); }
    $('m-test-result').textContent = thenTest ? 'Saving and testing…' : 'Saving…';
    return helper('POST', '/config', b).then(function (st) {
      mail.status = st; $('m-pass').value = ''; fillMailForm(); renderMailBadge();
      if (!thenTest) { $('m-test-result').textContent = 'Saved.'; return; }
      return helper('POST', '/test').then(function (r) {
        var t = function (name, x) { return name + ': ' + (x.ok ? 'OK' : x.error); };
        $('m-test-result').textContent = t('Sending (SMTP)', r.smtp) + ' · ' + t('Mailbox (IMAP)', r.imap);
        $('m-test-result').className = r.smtp.ok && r.imap.ok ? 'ok-text small' : 'error small';
      });
    }).then(function () { syncWatch(); return refreshHelper(); })
      .catch(function (e) { $('m-test-result').textContent = 'Failed: ' + e.message; $('m-test-result').className = 'error small'; });
  }

  // ---- sending
  function b64(bytes) { return M.base64(bytes); }

  /** Send notices by e-mail through the helper, one by one, after one confirmation. */
  function sendNotices(groups, opts) {
    opts = opts || {};
    if (!mailReady()) { openMail(); return; }
    groups = groups.filter(function (g) { return g.emails.length; });
    if (!groups.length) { prompt('Nothing to send', 'None of the chosen recipients has a nodal e-mail ID.'); return; }
    if (!preflight(groups)) return;
    ensureNotices(groups);
    var lines = groups.map(function (g) { return '• ' + g.bankName + ' → ' + g.emails.join(', ') + (g.notice && g.notice.sentAt ? '   (ALREADY SENT ' + fmtIso(g.notice.sentAt) + ')' : ''); });
    if (!window.confirm('Send ' + groups.length + ' notice(s) by e-mail from ' + mail.status.fromEmail + '?\n\n' + lines.join('\n') +
      '\n\nEach e-mail carries the notice (.docx) and the FIR copy. Check the notices (Preview) before sending.')) return;
    var s = currentSettings(), ci = caseInfo(), status = $('gen-status'), ok = [], failed = [], warnings = [];
    mail.sending = true; renderEmails();
    return firCopy().then(function (fc) {
      return groups.reduce(function (p, g, i) {
        return p.then(function () {
          status.textContent = 'Sending ' + (i + 1) + ' of ' + groups.length + ': ' + g.bankName + '…';
          return O.noticeDocx(g, state.templates, s, ci).then(O.bytesOf).then(function (docBytes) {
            var values = T.valuesFor(g, s, ci);
            var atts = [{ name: g.fileName, type: window.BNSSOutputs.DOCX_MIME, base64: b64(docBytes) }];
            if (fc) atts.push({ name: fc.name, type: fc.type, base64: b64(fc.data) });
            return helper('POST', '/send', { ref: g.noticeRef, to: g.emails, subject: T.fillText(state.templates.subject, values), text: T.fillText(state.templates.body, values), attachments: atts });
          }).then(function (r) {
            var n = g.notice;
            n.sentAt = null; setStatus(n, 'sent');
            Object.assign(n, { sentVia: 'email', messageId: r.messageId, sentTo: r.accepted, rejectedTo: r.rejected, sentFrom: mail.status.fromEmail });
            ok.push(g.bankName + (r.rejected.length ? ' (rejected: ' + r.rejected.map(function (x) { return x.rcpt; }).join(', ') + ')' : ''));
            if (r.warning) warnings.push(g.bankName + ': ' + r.warning);
          }).catch(function (e) { failed.push(g.bankName + ': ' + e.message); });
        });
      }, Promise.resolve());
    }).then(function () {
      mail.sending = false;
      scheduleSave();
      status.textContent = ok.length + ' sent' + (failed.length ? ', ' + failed.length + ' failed' : '') + '.';
      renderRecipients();
      syncWatch();
      var items = ok.map(function (x) { return '✓ Sent: ' + x; }).concat(failed.map(function (x) { return '✗ Not sent — ' + x; })).concat(warnings.map(function (x) { return '! ' + x; }));
      prompt(failed.length ? 'Some notices were not sent' : 'Notices sent', items);
    });
  }

  function sendAll() {
    computeRecipients();
    var groups = state.recipients.filter(sendable).filter(function (g) { return !g.notice || !g.notice.sentAt; });
    if (!groups.length) { prompt('Nothing to send', 'All notices with an e-mail ID have already been sent. Use the Send button on a row to send one again.'); return; }
    sendNotices(groups);
  }

  // ============================================================== PREVIEW
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

  function previewNotice(g, templates) {
    var tpl = templates || state.templates;
    var values = T.valuesFor(g, currentSettings(), state.cur ? caseInfo() : {});
    if (!g.noticeRef) values.notice_ref = '(assigned when generated)';
    var body = $('preview-body');
    renderBlocks(T.toBlocks(tpl.notice, values, g), body);
    body.appendChild(el('hr'));
    body.appendChild(el('p', { class: 'mailpreview' }, [el('strong', { text: 'E-mail subject: ' }), T.fillText(tpl.subject, values)]));
    body.appendChild(el('pre', { class: 'mailpreview', text: T.fillText(tpl.body, values) }));
    $('dlg-preview').showModal();
  }

  function demoGroup() {
    if (state.recipients && state.recipients.length) return state.recipients.filter(sendable)[0] || state.recipients[0];
    return { bankName: 'Example Bank', kind: 'bank', acks: ['99900000000101'], disputedPaise: 1000000, entry: null, items: [],
      accounts: [{ account: '000123456789', ifsc: 'EXMP0000001', acks: ['99900000000101'], disputedPaise: 1000000, txnCount: 1 }] };
  }

  // ============================================================= SETTINGS
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
    if (state.cur) renderChecklist(); else renderDashboard();
  }
  function officerWarning() {
    var s = state.settings;
    show('officer-warning', !(s.officerName && s.designation && s.station));
  }

  // ============================================================= TEMPLATES
  var lastFocused = null;
  function openTemplate() {
    $('tpl-text').value = state.templates.notice;
    $('tpl-subject').value = state.templates.subject;
    $('tpl-body').value = state.templates.body;
    templateWarn();
    $('dlg-template').showModal();
  }
  function editorTemplates() { return { notice: $('tpl-text').value, subject: $('tpl-subject').value, body: $('tpl-body').value }; }
  function templateWarn() {
    var t = editorTemplates(), msgs = [];
    var unknown = B.unknownPlaceholders(t.notice + '\n' + t.subject + '\n' + t.body);
    if (unknown.length) msgs.push('Unknown placeholder(s): ' + unknown.join(', '));
    if (!/\{\{\s*(accounts_table|identifiers_table)\s*\}\}/i.test(t.notice)) msgs.push('No {{accounts_table}} — the notice will not list the accounts / identifiers.');
    if (!/\{\{\s*requested_items\s*\}\}/i.test(t.notice)) msgs.push('No {{requested_items}} — the notice will not list the documents requested.');
    if (!/\{\{\s*notice_ref\s*\}\}/i.test(t.subject)) msgs.push('No {{notice_ref}} in the e-mail subject — replies cannot be matched automatically.');
    $('tpl-warn').textContent = msgs.join(' · ');
  }
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length; ta.focus(); templateWarn();
  }
  var TPL_SEP = '\n===== E-MAIL SUBJECT =====\n', TPL_SEP2 = '\n===== E-MAIL BODY =====\n';

  // ================================================================ BACKUP
  function backup() {
    flushSave().then(function () { return S.exportAll(M.base64); }).then(function (obj) {
      download(new Blob([JSON.stringify(obj)], { type: 'application/json' }), 'BNSS94_backup_' + stamp() + '.bnss94.json');
      toast('Backup downloaded — it contains case data, store it securely');
    });
  }
  function restore(file) {
    if (!file) return;
    file.text().then(function (txt) {
      var obj = JSON.parse(txt);
      var overwrite = window.confirm('Replace cases that already exist with the version in the backup?\n\nOK = replace, Cancel = keep the existing ones.');
      return S.importAll(obj, M.unbase64, overwrite);
    }).then(function (r) {
      toast('Restored ' + r.added + ' case(s)' + (r.skipped ? ', kept ' + r.skipped + ' existing' : ''));
      loadDirectory(); refreshCases();
    }).catch(function (e) { prompt('Restore failed', e.message); });
  }

  function deleteCase() {
    var c = state.cur;
    if (!c.firNo) { goHome(); return; }
    if (!window.confirm('Delete FIR ' + c.firNo + ' with its FIR copy, notices and saved replies from this browser? This cannot be undone.')) return;
    clearTimeout(saveTimer); saveTimer = null;
    S.getAll('files').then(function (files) {
      return Promise.all(files.filter(function (f) { return f.firNo === c.firNo; }).map(function (f) { return S.del('files', f.id); }));
    }).then(function () { return S.del('cases', c.firNo); }).then(function () {
      state.cur = null; showView('dashboard'); refreshCases(); toast('Case deleted');
    });
  }

  // ================================================================ WIRING
  function wireDrop(zone, input, handler) {
    input.addEventListener('change', function () { handler(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { handler(e.dataTransfer.files); });
  }

  function init() {
    ['dragover', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); }); });
    wireDrop($('drop-nodal'), $('file-nodal'), handleNodalFile);
    wireDrop($('drop-reply'), $('file-reply'), importReplies);
    wireDrop($('drop-txn'), $('file-txn'), handleTxnFiles);
    wireDrop($('drop-fir'), $('file-fir'), handleFirFile);
    $('btn-dir-save').addEventListener('click', saveDirectory);

    $('btn-home').addEventListener('click', goHome);
    $('btn-back').addEventListener('click', goHome);
    $('btn-new-case').addEventListener('click', function () { openCase(null); setTimeout(function () { $('c-firNo').focus(); }, 60); });
    $('btn-backup').addEventListener('click', backup);
    $('file-restore').addEventListener('change', function () { restore(this.files[0]); this.value = ''; });
    $('btn-delete-case').addEventListener('click', deleteCase);

    CASE_FIELDS.forEach(function (k) {
      $('c-' + k).addEventListener(k === 'firNo' ? 'change' : 'input', function () { onCaseField(k); });
    });

    $('btn-analyse').addEventListener('click', function () { runAnalysis(false); });
    ['f-text', 'f-min'].forEach(function (id) { $(id).addEventListener('input', renderResults); });
    ['f-repeated', 'f-match'].forEach(function (id) { $(id).addEventListener('change', renderResults); });
    $('sel-visible').addEventListener('click', function () { setSelection(filteredAccounts(), true); });
    $('unsel-visible').addEventListener('click', function () { setSelection(filteredAccounts(), false); });
    $('sel-default').addEventListener('click', function () {
      $('f-text').value = ''; $('f-min').value = ''; $('f-repeated').checked = false; $('f-match').value = '';
      state.sort = { key: 'rank', dir: 1 };
      setSelection(state.analysis.accounts, true);
    });

    $('btn-id-add').addEventListener('click', addIdentifiers);
    $('btn-bulk-tsp').addEventListener('click', bulkAssignTsp);

    ['g-date', 'g-days'].forEach(function (id) { $(id).addEventListener('input', function () { if (state.analysis) renderRecipients(); }); });
    $('btn-zip').addEventListener('click', downloadZip);
    $('btn-xlsx').addEventListener('click', downloadXlsx);
    $('btn-copy-tsv').addEventListener('click', function () { copyText(O.emailTsv(state.recipients.filter(sendable))); });
    $('btn-mark-all-sent').addEventListener('click', markAllSent);
    $('btn-send-all').addEventListener('click', sendAll);
    $('btn-mail').addEventListener('click', openMail);
    $('btn-check-mail').addEventListener('click', checkMailNow);
    $('m-connect').addEventListener('click', connectHelper);
    $('m-save').addEventListener('click', function () { saveMail(false); });
    $('m-test').addEventListener('click', function () { saveMail(true); });
    $('m-close').addEventListener('click', function () { $('dlg-mail').close(); });
    $('m-preset').addEventListener('change', function () {
      var p = PRESETS[this.value];
      if (!p) return;
      $('m-smtp-host').value = p.smtp.host; $('m-smtp-port').value = p.smtp.port; $('m-smtp-sec').value = p.smtp.secure ? 'tls' : 'starttls';
      $('m-imap-host').value = p.imap.host; $('m-imap-port').value = p.imap.port; $('m-imap-sec').value = p.imap.secure ? 'tls' : 'starttls';
    });
    $('file-reply-manual').addEventListener('change', function () { attachManualReply(this.files); this.value = ''; });

    $('btn-settings').addEventListener('click', openSettings);
    document.querySelectorAll('[data-open=settings]').forEach(function (b) { b.addEventListener('click', openSettings); });
    $('dlg-settings').addEventListener('close', settingsClosed);

    $('btn-template').addEventListener('click', openTemplate);
    ['tpl-text', 'tpl-subject', 'tpl-body'].forEach(function (id) {
      $(id).addEventListener('focus', function () { lastFocused = $(id); });
      $(id).addEventListener('input', templateWarn);
    });
    var chips = $('tpl-chips');
    B.PLACEHOLDERS.forEach(function (p) {
      chips.appendChild(el('button', { type: 'button', class: 'chip', title: p[1], text: '{{' + p[0] + '}}', onclick: function () { insertAtCursor(lastFocused || $('tpl-text'), '{{' + p[0] + '}}'); } }));
    });
    $('tpl-save').addEventListener('click', function () {
      state.templates = editorTemplates();
      var ok = save(KEYS.template, state.templates.notice) && save(KEYS.subject, state.templates.subject) && save(KEYS.body, state.templates.body);
      toast(ok ? 'Templates saved' : 'Templates applied (browser storage unavailable — not saved)');
      if (state.analysis) renderRecipients();
    });
    $('tpl-default').addEventListener('click', function () {
      if (!window.confirm('Replace the editor contents with the default templates?')) return;
      $('tpl-text').value = T.DEFAULT_TEMPLATE; $('tpl-subject').value = T.DEFAULT_EMAIL_SUBJECT; $('tpl-body').value = T.DEFAULT_EMAIL_BODY; templateWarn();
    });
    $('tpl-preview').addEventListener('click', function () { previewNotice(demoGroup(), editorTemplates()); });
    $('tpl-export').addEventListener('click', function () {
      var t = editorTemplates();
      download(t.notice + TPL_SEP + t.subject + TPL_SEP2 + t.body, 'bnss94_template.txt', 'text/plain;charset=utf-8');
    });
    $('tpl-import').addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      f.text().then(function (txt) {
        var a = txt.split(TPL_SEP), notice = a[0], rest = a[1] || '';
        var b = rest.split(TPL_SEP2);
        $('tpl-text').value = notice;
        if (a.length > 1) { $('tpl-subject').value = b[0].trim(); $('tpl-body').value = b[1] || ''; }
        templateWarn(); toast('Imported — click Save to keep it');
      });
      this.value = '';
    });
    $('tpl-close').addEventListener('click', function () { $('dlg-template').close(); });
    $('preview-close').addEventListener('click', function () { $('dlg-preview').close(); });
    $('prompt-close').addEventListener('click', function () { $('dlg-prompt').close(); });
    window.addEventListener('beforeunload', function () { if (saveTimer) doSave(); });

    officerWarning();
    S.init().then(function () {
      show('storage-warning', !S.persistent);
      return loadDirectory();
    }).then(refreshCases).then(function () {
      // Prompt on start-up when replies or overdue notices need attention.
      var replies = [], overdue = [];
      state.cases.forEach(function (c) { noticeAlerts(c).forEach(function (a) { (a.type === 'reply' ? replies : a.type === 'overdue' ? overdue : []).push('FIR ' + c.firNo + ': ' + a.text); }); });
      if (replies.length || overdue.length) prompt('Notices needing attention', replies.concat(overdue));
      // Mail helper: connect, tell it what to watch, collect replies — now and every minute.
      var tick = function () { return refreshHelper().then(function (ok) { if (ok && mailReady()) { syncWatch(); return pollReplies(); } }); };
      tick();
      setInterval(tick, 60000);
    });
  }

  init();
})();
