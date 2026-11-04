/*
 * BNSS94 Notice Tool — output builders (.docx notices, .eml drafts, .xlsx summary, .zip).
 *
 * Libraries are injected so this runs in the browser (window globals from
 * /vendor) and in Node tests:  BNSSOutputs.create({ docx, XLSX, JSZip })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./analysis.js'), require('./template.js'), require('./mail.js'));
  } else {
    root.BNSSOutputs = factory(root.BNSS, root.BNSSTemplate, root.BNSSMail);
  }
})(typeof self !== 'undefined' ? self : this, function (BNSS, T, M) {
  'use strict';

  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  function create(libs) {
    var docx = libs.docx, XLSX = libs.XLSX, JSZip = libs.JSZip;
    var inBrowser = typeof window !== 'undefined';

    function templatesOf(t) {
      if (typeof t === 'string' || !t) return { notice: t || T.DEFAULT_TEMPLATE, subject: T.DEFAULT_EMAIL_SUBJECT, body: T.DEFAULT_EMAIL_BODY };
      return { notice: t.notice || T.DEFAULT_TEMPLATE, subject: t.subject || T.DEFAULT_EMAIL_SUBJECT, body: t.body || T.DEFAULT_EMAIL_BODY };
    }

    function bytesOf(data) {
      if (data instanceof Uint8Array) return Promise.resolve(data);
      if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      return Promise.resolve(new Uint8Array(data));
    }

    // ------------------------------------------------------------------ Word
    var FONT = 'Times New Roman';

    function runsFor(runs, size) {
      if (!runs.length) runs = [{ text: '' }];
      return runs.map(function (r) {
        return new docx.TextRun({ text: r.text, bold: !!r.bold, underline: r.underline ? {} : undefined, font: FONT, size: size || 24 });
      });
    }

    function cell(text, opts) {
      opts = opts || {};
      return new docx.TableCell({
        children: [new docx.Paragraph({
          alignment: opts.align || docx.AlignmentType.LEFT,
          children: [new docx.TextRun({ text: String(text), bold: !!opts.bold, font: FONT, size: 20 })]
        })],
        shading: opts.shade ? { type: docx.ShadingType.CLEAR, color: 'auto', fill: 'D9D9D9' } : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 }
      });
    }

    // Column widths in twips (A4 text width with 2 cm margins ≈ 9638 twips).
    var LAYOUTS = {
      6: { widths: [680, 2150, 1700, 2608, 1700, 800], align: ['C', null, null, null, 'R', 'C'] },
      4: { widths: [680, 4600, 1800, 2558], align: ['C', null, null, null] }
    };

    function tableFor(block) {
      var A = { C: docx.AlignmentType.CENTER, R: docx.AlignmentType.RIGHT };
      var layout = LAYOUTS[block.headers.length] || { widths: block.headers.map(function () { return Math.floor(9638 / block.headers.length); }), align: [] };
      var al = function (i) { return A[layout.align[i]] || undefined; };
      var header = new docx.TableRow({
        tableHeader: true,
        children: block.headers.map(function (h, i) { return cell(h, { bold: true, shade: true, align: al(i) }); })
      });
      var rows = block.rows.map(function (r) {
        return new docx.TableRow({ cantSplit: true, children: r.map(function (v, i) { return cell(v, { align: al(i) }); }) });
      });
      return new docx.Table({ width: { size: 9638, type: docx.WidthType.DXA }, columnWidths: layout.widths, rows: [header].concat(rows) });
    }

    function documentFor(blocks, meta) {
      var ALIGN = { left: docx.AlignmentType.JUSTIFIED, center: docx.AlignmentType.CENTER, right: docx.AlignmentType.RIGHT };
      var children = blocks.map(function (b) {
        if (b.type === 'table') return tableFor(b);
        return new docx.Paragraph({ alignment: ALIGN[b.align] || ALIGN.left, spacing: { after: 60 }, children: runsFor(b.runs) });
      });
      return new docx.Document({
        creator: (meta && meta.creator) || 'BNSS94 Notice Tool',
        title: (meta && meta.title) || 'Notice under Section 94 BNSS',
        styles: { default: { document: { run: { font: FONT, size: 24 } } } },
        sections: [{
          properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
          children: children
        }]
      });
    }

    function pack(doc) {
      if (inBrowser && docx.Packer.toBlob) return docx.Packer.toBlob(doc);
      return docx.Packer.toBuffer(doc);
    }

    /** Build the .docx for one recipient group. Resolves to a Blob (browser) or Buffer (Node). */
    function noticeDocx(group, template, settings, caseInfo) {
      settings = settings || {};
      var values = T.valuesFor(group, settings, caseInfo);
      var blocks = T.toBlocks(templatesOf(template).notice, values, group);
      return pack(documentFor(blocks, { creator: settings.officerName, title: 'Sec 94 BNSS notice – ' + group.bankName }));
    }

    /** E-mail draft (.eml text) for one group, with the notice and FIR copy attached. */
    function noticeEml(group, docxBytes, ctx, templates) {
      var t = templatesOf(templates), s = ctx.settings || {};
      var values = T.valuesFor(group, s, ctx.caseInfo);
      var attachments = [{ name: group.fileName, type: DOCX_MIME, data: docxBytes }];
      if (ctx.firCopy && ctx.firCopy.data) attachments.push({ name: ctx.firCopy.name, type: ctx.firCopy.type, data: ctx.firCopy.data });
      return M.buildEml({
        fromName: s.officerName, fromEmail: s.officerEmail, to: group.emails,
        subject: T.fillText(t.subject, values), text: T.fillText(t.body, values),
        attachments: attachments, messageId: group.noticeRef
      });
    }

    /** Give every group a unique attachment file name. Mutates groups (adds .fileName and .emlName). */
    function assignFileNames(groups, settings) {
      var used = {};
      groups.forEach(function (g) {
        var name = BNSS.noticeFileName(g.bankName, settings && settings.caseRef), n = 1, base = name.replace(/\.docx$/, '');
        while (used[name.toLowerCase()]) { n++; name = base + '_' + n + '.docx'; }
        used[name.toLowerCase()] = true;
        g.fileName = name;
        g.emlName = name.replace(/\.docx$/, '.eml');
      });
      return groups;
    }

    // ----------------------------------------------------------------- Excel
    function sheet(aoa, widths) {
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws['!cols'] = widths.map(function (w) { return { wch: w }; });
      if (aoa.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
      return ws;
    }

    function emailsText(g) { return g.emails.length ? g.emails.join('; ') : 'NOT FOUND – update nodal sheet'; }

    var METHOD_NAMES = { ifsc: 'IFSC prefix', name: 'Bank name (fuzzy)', manual: 'Manual', domain: 'Domain / UPI handle' };
    function methodText(g) {
      if (!g.entry) return 'Unmatched';
      return Object.keys(g.methods || {}).map(function (m) { return METHOD_NAMES[m] || m; }).join(' + ');
    }

    function requestedText(g) { return T.requestedFor(g).map(function (r) { return r.short; }).join(', '); }

    /**
     * Excel summary workbook.
     * @param ctx { analysis, accounts (all L1, each with .selected), groups (recipients, with fileName),
     *              unmatched, settings, caseInfo, identifiers (each with .selected, .match) }
     * @returns Uint8Array
     */
    function summaryXlsx(ctx) {
      var wb = XLSX.utils.book_new();
      var s = ctx.settings || {}, c = ctx.caseInfo || {}, st = ctx.analysis.stats;
      var selected = ctx.accounts.filter(function (a) { return a.selected; });
      var idents = ctx.identifiers || [];

      var info = [
        ['BNSS94 Notice Tool – Summary'],
        [],
        ['FIR number', c.firNo || ''],
        ['FIR date', c.firDate || ''],
        ['Police station', c.policeStation || ''],
        ['Sections of law', c.sections || ''],
        ['Generated on', BNSS.formatDate(new Date())],
        ['Notice date', s.noticeDate || BNSS.formatDate(new Date())],
        ['Officer', [s.officerName, s.designation, s.station].filter(Boolean).join(', ')],
        [],
        ['Transaction rows read', st.totalRows],
        ['NCRP Ack numbers', st.ackCount],
        ['Total loss – Layer 1 disputed (₹)', BNSS.paiseToNumber(st.totalLossPaise || st.disputedPaise)],
        ['Total put on hold (₹)', st.holdMapped ? BNSS.paiseToNumber(st.totalHoldPaise) : 'column not mapped'],
        ['Layer 1 rows (unique)', st.layerRows],
        ['Layer 1 accounts', st.accountCount],
        ['Accounts repeated across Ack nos', st.repeatedCount],
        ['Accounts selected for notices', selected.length],
        ['Other identifiers selected', idents.filter(function (i) { return i.selected; }).length],
        ['Notices (recipients)', ctx.groups.length],
        ['Recipients without nodal e-mail', ctx.unmatched.length],
        [],
        ['Ack numbers', st.acks.join(', ')],
        [],
        ['Warnings']
      ].concat((ctx.analysis.warnings.length ? ctx.analysis.warnings : ['None']).map(function (w) { return [w]; }));
      var wsInfo = XLSX.utils.aoa_to_sheet(info);
      wsInfo['!cols'] = [{ wch: 36 }, { wch: 80 }];
      XLSX.utils.book_append_sheet(wb, wsInfo, 'Summary');

      var acks = [['Ack No', 'Total Loss – Layer 1 Disputed (₹)', 'Put on Hold (₹)', 'Layers', 'Layer 1 Accounts', 'Rows']];
      (ctx.analysis.ackSummary || []).forEach(function (a) {
        acks.push([a.ack, BNSS.paiseToNumber(a.lossPaise), BNSS.paiseToNumber(a.holdPaise), a.layers.join(', '), a.l1AccountCount, a.rowCount]);
      });
      XLSX.utils.book_append_sheet(wb, sheet(acks, [18, 22, 16, 12, 14, 8]), 'Ack Summary');

      var l1 = [['Rank', 'Selected', 'Account No', 'Bank (as in NCRP)', 'Matched Nodal Bank', 'Match', 'IFSC', 'No. of Ack Nos', 'Ack Nos', 'Total Disputed (₹)', 'Txn Count', 'Total Txn Amount (₹)', 'Warning']];
      ctx.accounts.forEach(function (a, i) {
        l1.push([i + 1, a.selected ? 'Yes' : 'No', a.account, a.bank, a.match && a.match.entry ? a.match.entry.bank : 'UNMATCHED',
          a.match ? a.match.method : '', a.ifsc, a.ackCount, a.acks.join(', '), BNSS.paiseToNumber(a.disputedPaise), a.txnCount,
          BNSS.paiseToNumber(a.amountPaise), a.warning || '']);
      });
      XLSX.utils.book_append_sheet(wb, sheet(l1, [6, 9, 22, 28, 28, 8, 14, 9, 40, 16, 9, 16, 30]), 'Layer1 Analysis');

      var bw = [['Bank', 'Nodal E-mail(s)', 'Notice File', 'S.No', 'Account No', 'IFSC', 'Ack Nos', 'Disputed (₹)', 'Txn Count']];
      ctx.groups.forEach(function (g) {
        (g.accounts || []).forEach(function (a, i) {
          bw.push([g.bankName, emailsText(g), g.fileName, i + 1, a.account, a.ifsc, a.acks.join(', '), BNSS.paiseToNumber(a.disputedPaise), a.txnCount]);
        });
      });
      XLSX.utils.book_append_sheet(wb, sheet(bw, [30, 45, 40, 6, 22, 14, 40, 14, 9]), 'Bank-wise Accounts');

      var idSheet = [['Selected', 'Identifier', 'Type', 'Recipient', 'Match', 'Ack Nos', 'Source', 'Warning']];
      idents.forEach(function (it) {
        idSheet.push([it.selected ? 'Yes' : 'No', it.value, BNSS.ID_TYPES[it.type] || it.type, it.match && it.match.entry ? it.match.entry.bank : 'UNASSIGNED',
          it.match ? it.match.method : '', it.acks.join(', '), it.sources.join(', '), it.warning || '']);
      });
      XLSX.utils.book_append_sheet(wb, sheet(idSheet, [9, 40, 18, 30, 10, 40, 10, 30]), 'Identifiers');

      var em = [['Recipient', 'Category', 'Notice Ref', 'Nodal E-mail(s)', 'Attachment', 'E-mail Draft', 'Accounts', 'Identifiers', 'Documents Requested', 'Ack Nos', 'Match', 'Names in NCRP data']];
      ctx.groups.forEach(function (g) {
        em.push([g.bankName, BNSS.CATEGORIES[g.kind] || g.kind, g.noticeRef || '', emailsText(g), g.fileName, g.emlName || '',
          (g.accounts || []).length, (g.items || []).length, requestedText(g), g.acks.join(', '), methodText(g), (g.rawNames || []).join('; ')]);
      });
      XLSX.utils.book_append_sheet(wb, sheet(em, [30, 18, 20, 50, 40, 40, 9, 11, 50, 40, 18, 40]), 'Email Mapping');

      var tx = [['Ack No', 'Account No', 'Bank', 'IFSC', 'Transaction ID / UTR', 'Transaction Date', 'Amount (₹)', 'Disputed (₹)', 'Source Row']];
      ctx.accounts.forEach(function (a) {
        a.transactions.forEach(function (t) {
          tx.push([t.ack, a.account, a.bank, a.ifsc, t.txnId, t.date, BNSS.paiseToNumber(t.amountPaise), BNSS.paiseToNumber(t.disputedPaise), t.row || '']);
        });
      });
      XLSX.utils.book_append_sheet(wb, sheet(tx, [18, 22, 28, 14, 24, 14, 12, 12, 10]), 'Layer1 Transactions');

      if (ctx.unmatched.length) {
        var um = [['Recipient / names in NCRP data', 'Problem', 'Closest nodal entry', 'Accounts / identifiers']];
        ctx.unmatched.forEach(function (g) {
          um.push([(g.rawNames || []).join('; ') || g.bankName, g.entry ? 'Matched but no e-mail in nodal sheet' : 'No nodal officer matched',
            g.suggestion ? g.suggestion.bank : '',
            (g.accounts || []).map(function (a) { return a.account; }).concat((g.items || []).map(function (i) { return i.value; })).join(', ')]);
        });
        XLSX.utils.book_append_sheet(wb, sheet(um, [40, 36, 30, 50]), 'Unmatched');
      }

      // Account / Ack numbers are written as strings above, so they stay text cells.
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      return new Uint8Array(out);
    }

    function csvCell(v) {
      v = String(v == null ? '' : v);
      // Prefix formula-like values so spreadsheet apps do not execute them.
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }

    function emailCsv(groups) {
      var lines = [['Recipient', 'Notice Ref', 'Nodal E-mail(s)', 'Attachment', 'E-mail Draft', 'Accounts', 'Identifiers', 'Ack Nos'].map(csvCell).join(',')];
      groups.forEach(function (g) {
        lines.push([g.bankName, g.noticeRef || '', g.emails.join('; ') || 'NOT FOUND', g.fileName, g.emlName || '', (g.accounts || []).length,
          (g.items || []).length, g.acks.join(' ')].map(csvCell).join(','));
      });
      return '﻿' + lines.join('\r\n') + '\r\n';
    }

    /** Copy-ready tab-separated table (pastes into Excel / Outlook / Word as a table). */
    function emailTsv(groups) {
      var lines = ['Recipient\tNodal E-mail(s)\tAttachment\tNotice Ref'];
      groups.forEach(function (g) { lines.push([g.bankName, g.emails.join('; ') || 'NOT FOUND', g.fileName, g.noticeRef || ''].join('\t')); });
      return lines.join('\n');
    }

    /**
     * Build all notices, e-mail drafts, the FIR copy and the summary into one ZIP.
     * @returns Promise<Blob|Buffer>
     */
    function bundleZip(ctx, templates) {
      var zip = new JSZip();
      var folder = zip.folder('Notices'), drafts = zip.folder('Email_Drafts');
      var jobs = ctx.groups.map(function (g) {
        return noticeDocx(g, templates, ctx.settings, ctx.caseInfo).then(bytesOf).then(function (bytes) {
          folder.file(g.fileName, bytes);
          if (g.emails.length) drafts.file(g.emlName, noticeEml(g, bytes, ctx, templates));
        });
      });
      return Promise.all(jobs).then(function () {
        if (ctx.firCopy && ctx.firCopy.data) zip.file(ctx.firCopy.name, ctx.firCopy.data);
        zip.file('BNSS94_Summary.xlsx', summaryXlsx(ctx));
        zip.file('Email_List.csv', emailCsv(ctx.groups));
        zip.file('Email_List.txt', emailTsv(ctx.groups) + '\n');
        return zip.generateAsync({ type: inBrowser ? 'blob' : 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/zip' });
      });
    }

    return {
      noticeDocx: noticeDocx,
      noticeEml: noticeEml,
      bytesOf: bytesOf,
      assignFileNames: assignFileNames,
      summaryXlsx: summaryXlsx,
      emailCsv: emailCsv,
      emailTsv: emailTsv,
      bundleZip: bundleZip,
      methodText: methodText,
      requestedText: requestedText
    };
  }

  return { create: create, DOCX_MIME: DOCX_MIME };
});
