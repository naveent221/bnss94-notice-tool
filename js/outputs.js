/*
 * BNSS94 Notice Tool — output builders (.docx notices, .xlsx summary, .zip).
 *
 * Libraries are injected so this runs in the browser (window globals from
 * /vendor) and in Node tests:  BNSSOutputs.create({ docx, XLSX, JSZip })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./analysis.js'), require('./template.js'));
  } else {
    root.BNSSOutputs = factory(root.BNSS, root.BNSSTemplate);
  }
})(typeof self !== 'undefined' ? self : this, function (BNSS, T) {
  'use strict';

  function create(libs) {
    var docx = libs.docx, XLSX = libs.XLSX, JSZip = libs.JSZip;

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
    var COL_WIDTHS = [600, 2300, 1400, 2938, 1600, 800];

    function tableFor(block) {
      var R = docx.AlignmentType.RIGHT, C = docx.AlignmentType.CENTER;
      var aligns = [C, null, null, null, R, C];
      var header = new docx.TableRow({
        tableHeader: true,
        children: block.headers.map(function (h, i) { return cell(h, { bold: true, shade: true, align: aligns[i] || undefined }); })
      });
      var rows = block.rows.map(function (r) {
        return new docx.TableRow({ cantSplit: true, children: r.map(function (v, i) { return cell(v, { align: aligns[i] || undefined }); }) });
      });
      return new docx.Table({
        width: { size: 9638, type: docx.WidthType.DXA },
        columnWidths: COL_WIDTHS,
        rows: [header].concat(rows)
      });
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
      if (typeof window !== 'undefined' && docx.Packer.toBlob) return docx.Packer.toBlob(doc);
      return docx.Packer.toBuffer(doc);
    }

    /** Build the .docx for one bank group. Resolves to a Blob (browser) or Buffer (Node). */
    function noticeDocx(group, template, settings) {
      var values = T.valuesFor(group, settings);
      var blocks = T.toBlocks(template, values, group.accounts);
      return pack(documentFor(blocks, { creator: settings.officerName, title: 'Sec 94 BNSS notice – ' + group.bankName }));
    }

    /** Give every group a unique attachment file name. Mutates groups (adds .fileName). */
    function assignFileNames(groups, settings) {
      var used = {};
      groups.forEach(function (g) {
        var name = BNSS.noticeFileName(g.bankName, settings && settings.caseRef), n = 1, base = name.replace(/\.docx$/, '');
        while (used[name.toLowerCase()]) { n++; name = base + '_' + n + '.docx'; }
        used[name.toLowerCase()] = true;
        g.fileName = name;
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

    function methodText(g) {
      if (!g.entry) return 'Unmatched';
      return Object.keys(g.methods).map(function (m) { return { ifsc: 'IFSC prefix', name: 'Bank name (fuzzy)', manual: 'Manual' }[m] || m; }).join(' + ');
    }

    /**
     * Excel summary workbook.
     * @param ctx { analysis, accounts (all L1, each with .selected), groups (selected, with fileName), unmatched, settings, directory }
     * @returns Uint8Array
     */
    function summaryXlsx(ctx) {
      var wb = XLSX.utils.book_new();
      var s = ctx.settings || {}, st = ctx.analysis.stats;
      var selected = ctx.accounts.filter(function (a) { return a.selected; });

      var info = [
        ['BNSS94 Notice Tool – Summary'],
        [],
        ['Generated on', BNSS.formatDate(new Date())],
        ['Notice date', s.noticeDate || BNSS.formatDate(new Date())],
        ['Case reference', s.caseRef || ''],
        ['Officer', [s.officerName, s.designation, s.station].filter(Boolean).join(', ')],
        [],
        ['Transaction rows read', st.totalRows],
        ['NCRP Ack numbers', st.ackCount],
        ['Layer 1 rows', st.layerRows],
        ['Layer 1 accounts', st.accountCount],
        ['Accounts repeated across Ack nos', st.repeatedCount],
        ['Total Layer 1 disputed amount (₹)', BNSS.paiseToNumber(st.disputedPaise)],
        ['Accounts selected for notices', selected.length],
        ['Banks / notices', ctx.groups.length],
        ['Banks without nodal e-mail', ctx.unmatched.length],
        [],
        ['Ack numbers', st.acks.join(', ')],
        [],
        ['Warnings'],
      ].concat((ctx.analysis.warnings.length ? ctx.analysis.warnings : ['None']).map(function (w) { return [w]; }));
      var wsInfo = XLSX.utils.aoa_to_sheet(info);
      wsInfo['!cols'] = [{ wch: 36 }, { wch: 80 }];
      XLSX.utils.book_append_sheet(wb, wsInfo, 'Summary');

      var l1 = [['Rank', 'Selected', 'Account No', 'Bank (as in NCRP)', 'Matched Nodal Bank', 'Match', 'IFSC', 'No. of Ack Nos', 'Ack Nos', 'Total Disputed (₹)', 'Txn Count', 'Total Txn Amount (₹)', 'Warning']];
      ctx.accounts.forEach(function (a, i) {
        l1.push([i + 1, a.selected ? 'Yes' : 'No', a.account, a.bank, a.match && a.match.entry ? a.match.entry.bank : 'UNMATCHED',
          a.match ? a.match.method : '', a.ifsc, a.ackCount, a.acks.join(', '), BNSS.paiseToNumber(a.disputedPaise), a.txnCount,
          BNSS.paiseToNumber(a.amountPaise), a.warning || '']);
      });
      XLSX.utils.book_append_sheet(wb, sheet(l1, [6, 9, 22, 28, 28, 8, 14, 9, 40, 16, 9, 16, 30]), 'Layer1 Analysis');

      var bw = [['Bank', 'Nodal E-mail(s)', 'Notice File', 'S.No', 'Account No', 'IFSC', 'Ack Nos', 'Disputed (₹)', 'Txn Count']];
      ctx.groups.forEach(function (g) {
        g.accounts.forEach(function (a, i) {
          bw.push([g.bankName, emailsText(g), g.fileName, i + 1, a.account, a.ifsc, a.acks.join(', '), BNSS.paiseToNumber(a.disputedPaise), a.txnCount]);
        });
      });
      XLSX.utils.book_append_sheet(wb, sheet(bw, [30, 45, 40, 6, 22, 14, 40, 14, 9]), 'Bank-wise Accounts');

      var em = [['Bank', 'Nodal E-mail(s)', 'Attachment', 'Accounts', 'Total Disputed (₹)', 'Ack Nos', 'Match', 'Bank names in NCRP data']];
      ctx.groups.forEach(function (g) {
        em.push([g.bankName, emailsText(g), g.fileName, g.accounts.length, BNSS.paiseToNumber(g.disputedPaise), g.acks.join(', '), methodText(g), g.rawNames.join('; ')]);
      });
      XLSX.utils.book_append_sheet(wb, sheet(em, [30, 50, 40, 9, 16, 40, 18, 40]), 'Email Mapping');

      var tx = [['Ack No', 'Account No', 'Bank', 'IFSC', 'Transaction ID / UTR', 'Transaction Date', 'Amount (₹)', 'Disputed (₹)', 'Source Row']];
      ctx.accounts.forEach(function (a) {
        a.transactions.forEach(function (t) {
          tx.push([t.ack, a.account, a.bank, a.ifsc, t.txnId, t.date, BNSS.paiseToNumber(t.amountPaise), BNSS.paiseToNumber(t.disputedPaise), t.row || '']);
        });
      });
      XLSX.utils.book_append_sheet(wb, sheet(tx, [18, 22, 28, 14, 24, 14, 12, 12, 10]), 'Layer1 Transactions');

      if (ctx.unmatched.length) {
        var um = [['Bank name(s) in NCRP data', 'Problem', 'Closest nodal entry', 'Accounts']];
        ctx.unmatched.forEach(function (g) {
          um.push([g.rawNames.join('; ') || g.bankName, g.entry ? 'Matched but no e-mail in nodal sheet' : 'No match in nodal sheet',
            g.suggestion ? g.suggestion.bank : '', g.accounts.map(function (a) { return a.account; }).join(', ')]);
        });
        XLSX.utils.book_append_sheet(wb, sheet(um, [40, 36, 30, 50]), 'Unmatched Banks');
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
      var lines = [['Bank', 'Nodal E-mail(s)', 'Attachment', 'Accounts', 'Ack Nos'].map(csvCell).join(',')];
      groups.forEach(function (g) {
        lines.push([g.bankName, g.emails.join('; ') || 'NOT FOUND', g.fileName, g.accounts.length, g.acks.join(' ')].map(csvCell).join(','));
      });
      return '﻿' + lines.join('\r\n') + '\r\n';
    }

    /** Copy-ready tab-separated table (pastes into Excel / Outlook / Word as a table). */
    function emailTsv(groups) {
      var lines = ['Bank\tNodal E-mail(s)\tAttachment'];
      groups.forEach(function (g) { lines.push([g.bankName, g.emails.join('; ') || 'NOT FOUND', g.fileName].join('\t')); });
      return lines.join('\n');
    }

    /**
     * Build all notices plus the summary into one ZIP.
     * @returns Promise<Blob|Buffer>
     */
    function bundleZip(ctx, template) {
      var zip = new JSZip();
      var folder = zip.folder('Notices');
      var jobs = ctx.groups.map(function (g) {
        return noticeDocx(g, template, ctx.settings).then(function (data) { folder.file(g.fileName, data); });
      });
      return Promise.all(jobs).then(function () {
        zip.file('BNSS94_Summary.xlsx', summaryXlsx(ctx));
        zip.file('Email_List.csv', emailCsv(ctx.groups));
        zip.file('Email_List.txt', emailTsv(ctx.groups) + '\n');
        var type = typeof window !== 'undefined' ? 'blob' : 'nodebuffer';
        return zip.generateAsync({ type: type, compression: 'DEFLATE', mimeType: 'application/zip' });
      });
    }

    return {
      noticeDocx: noticeDocx,
      assignFileNames: assignFileNames,
      summaryXlsx: summaryXlsx,
      emailCsv: emailCsv,
      emailTsv: emailTsv,
      bundleZip: bundleZip,
      methodText: methodText
    };
  }

  return { create: create };
});
