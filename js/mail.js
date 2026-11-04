/*
 * BNSS94 Notice Tool — e-mail drafts (.eml) and reply parsing.
 *
 * The tool never sends mail itself (it makes no network connections). Instead
 * it writes standard .eml files with the notice and FIR copy attached. The
 * "X-Unsent: 1" header makes Outlook open them as a ready-to-send draft;
 * Thunderbird opens them with "Edit as New".
 *
 * Replies saved from any mail client as .eml are parsed here, their
 * attachments extracted, and they are matched back to the notice by the
 * reference code in the subject (or by the sender's address).
 *
 * Pure functions; works in the browser (window.BNSSMail) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BNSSMail = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- byte helpers
  function utf8Bytes(str) { return new TextEncoder().encode(String(str)); }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return utf8Bytes(data == null ? '' : data);
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64(bytes) {
    bytes = toBytes(bytes);
    var out = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
    }
    var rest = bytes.length - i;
    if (rest === 1) { var a = bytes[i] << 16; out += B64[a >> 18 & 63] + B64[a >> 12 & 63] + '=='; }
    else if (rest === 2) { var b = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[b >> 18 & 63] + B64[b >> 12 & 63] + B64[b >> 6 & 63] + '='; }
    return out;
  }

  var B64_LOOKUP = (function () { var t = {}; for (var i = 0; i < 64; i++) t[B64[i]] = i; t['-'] = 62; t._ = 63; return t; })();

  function unbase64(str) {
    var s = String(str).replace(/[^A-Za-z0-9+/\-_]/g, '');
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64_LOOKUP[s[i]]; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
    }
    return out.subarray(0, o);
  }

  function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n'); }

  /** Binary string (one char per byte) ↔ bytes, used to keep raw .eml bytes intact while parsing. */
  function bytesToBinary(bytes) {
    var out = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return out;
  }
  function binaryToBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  function decodeCharset(bytes, charset) {
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
    catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  // --------------------------------------------------------------- building
  function encodeWord(s) {
    s = String(s == null ? '' : s);
    return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + base64(utf8Bytes(s)) + '?=';
  }

  function address(name, email) {
    if (!email) return '';
    if (!name) return email;
    var n = /^[\x20-\x7e]*$/.test(name) ? '"' + String(name).replace(/["\\]/g, '') + '"' : encodeWord(name);
    return n + ' <' + email + '>';
  }

  function quoteParam(s) { return '"' + String(s).replace(/["\\\r\n]/g, '_') + '"'; }

  /**
   * Build an .eml draft.
   * @param m { fromName, fromEmail, to: [..], cc: [..], subject, text, attachments: [{ name, type, data }], messageId, date, unsent }
   * @returns string with CRLF line endings
   */
  function buildEml(m) {
    var boundary = '----=_BNSS94_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var h = [];
    if (m.fromEmail) h.push('From: ' + address(m.fromName, m.fromEmail));
    h.push('To: ' + (m.to || []).join(', '));
    if (m.cc && m.cc.length) h.push('Cc: ' + m.cc.join(', '));
    h.push('Subject: ' + encodeWord(m.subject));
    h.push('Date: ' + (m.date || new Date()).toUTCString().replace('GMT', '+0000'));
    var mid = String(m.messageId || boundary.slice(13)).replace(/[<>\s]/g, '');
    h.push('Message-ID: <' + (mid.indexOf('@') > 0 ? mid : mid + '@bnss94.local') + '>');
    if (m.unsent !== false) h.push('X-Unsent: 1');
    h.push('MIME-Version: 1.0');
    h.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    var parts = [
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(base64(utf8Bytes(String(m.text || '').replace(/\r?\n/g, '\r\n'))))
    ];
    (m.attachments || []).forEach(function (a) {
      var name = encodeWord(a.name);
      parts.push('--' + boundary,
        'Content-Type: ' + (a.type || 'application/octet-stream') + '; name=' + quoteParam(name),
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename=' + quoteParam(name),
        '',
        wrap76(base64(toBytes(a.data))));
    });
    parts.push('--' + boundary + '--', '');
    return h.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  }

  // ---------------------------------------------------------------- parsing
  /** Decode RFC 2047 encoded-words in a header value. */
  function decodeWords(s) {
    return String(s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (m, cs, enc, txt) {
      var bytes = enc.toUpperCase() === 'B' ? unbase64(txt)
        : binaryToBytes(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, function (x, hh) { return String.fromCharCode(parseInt(hh, 16)); }));
      return decodeCharset(bytes, cs);
    });
  }

  function parseHeaders(block) {
    var headers = {};
    block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i <= 0) return;
      var k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
      headers[k] = headers[k] ? headers[k] + ', ' + v : v;
    });
    return headers;
  }

  /** Parse "type/sub; a=b; c="d"" → { value, params }. Handles RFC 2231 name*= and name*0*= forms. */
  function parseParams(v) {
    var segs = [], cur = '', q = false;
    String(v || '').split('').forEach(function (ch) {
      if (ch === '"') q = !q;
      if (ch === ';' && !q) { segs.push(cur); cur = ''; } else cur += ch;
    });
    segs.push(cur);
    var params = {}, ext = {};
    segs.slice(1).forEach(function (p) {
      var i = p.indexOf('=');
      if (i < 0) return;
      var k = p.slice(0, i).trim().toLowerCase(), val = p.slice(i + 1).trim().replace(/^"|"$/g, '');
      var m = k.match(/^([^*]+)\*(\d+)?(\*)?$/);
      if (m) { (ext[m[1]] = ext[m[1]] || []).push({ n: +(m[2] || 0), v: val, enc: !!m[3] || !m[2] }); }
      else params[k] = decodeWords(val);
    });
    Object.keys(ext).forEach(function (k) {
      var pieces = ext[k].sort(function (a, b) { return a.n - b.n; });
      var charset = 'utf-8', raw = '';
      pieces.forEach(function (p, idx) {
        var v = p.v;
        if (idx === 0 && p.enc) { var mm = v.match(/^([^']*)'[^']*'(.*)$/); if (mm) { charset = mm[1] || charset; v = mm[2]; } }
        raw += p.enc ? v.replace(/%([0-9A-Fa-f]{2})/g, function (x, hh) { return String.fromCharCode(parseInt(hh, 16)); }) : v;
      });
      params[k] = decodeCharset(binaryToBytes(raw), charset);
    });
    return { value: segs[0].trim().toLowerCase(), params: params };
  }

  function decodeBody(body, cte) {
    cte = String(cte || '').toLowerCase();
    if (cte === 'base64') return unbase64(body);
    if (cte === 'quoted-printable') {
      return binaryToBytes(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (m, hh) { return String.fromCharCode(parseInt(hh, 16)); }));
    }
    return binaryToBytes(body);
  }

  function parsePart(raw, out) {
    var m = raw.match(/\r?\n\r?\n/);
    var headBlock = m ? raw.slice(0, m.index) : raw, body = m ? raw.slice(m.index + m[0].length) : '';
    var headers = parseHeaders(headBlock);
    var ct = parseParams(headers['content-type'] || 'text/plain');
    var cd = parseParams(headers['content-disposition'] || '');
    if (/^multipart\//.test(ct.value) && ct.params.boundary) {
      var b = '--' + ct.params.boundary;
      var end = body.indexOf(b + '--');
      if (end >= 0) body = body.slice(0, end); // drop the epilogue after the closing boundary
      var chunks = body.split(new RegExp('(?:^|\\r?\\n)' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*(?=\\r?\\n|$)'));
      chunks.slice(1).forEach(function (c) {
        var trimmed = c.replace(/^\r?\n/, '');
        if (trimmed.trim()) parsePart(trimmed, out);
      });
      return headers;
    }
    var filename = cd.params.filename || ct.params.name;
    var bytes = decodeBody(body, headers['content-transfer-encoding']);
    if (filename || cd.value === 'attachment' || /^message\/rfc822/.test(ct.value)) {
      out.attachments.push({ name: filename || ('attachment-' + (out.attachments.length + 1) + (/rfc822/.test(ct.value) ? '.eml' : '')), type: ct.value, data: bytes });
    } else if (ct.value === 'text/plain' && !out.text) {
      out.text = decodeCharset(bytes, ct.params.charset);
    } else if (ct.value === 'text/html' && !out.html) {
      out.html = decodeCharset(bytes, ct.params.charset);
    }
    return headers;
  }

  function emailsIn(s) {
    var m = String(s || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    return m ? m.map(function (e) { return e.toLowerCase(); }) : [];
  }

  /** Parse an .eml file (Uint8Array / ArrayBuffer / string). */
  function parseEml(input) {
    var raw = typeof input === 'string' ? input : bytesToBinary(toBytes(input));
    var out = { text: '', html: '', attachments: [] };
    var headers = parsePart(raw, out);
    if (!out.text && out.html) {
      out.text = out.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }
    out.headers = headers;
    out.subject = decodeWords(headers.subject || '');
    out.from = decodeWords(headers.from || '');
    out.fromEmail = emailsIn(headers.from)[0] || '';
    out.to = emailsIn(headers.to);
    var d = headers.date ? new Date(headers.date) : null;
    out.date = d && !isNaN(d) ? d : null;
    return out;
  }

  // ---------------------------------------------------------------- matching
  var REF_RE = /N94-[A-Za-z0-9.]+-\d{2,}/gi;

  function noticeRef(firNo, seq) {
    var slug = String(firNo || 'NOFIR').replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '').toUpperCase() || 'NOFIR';
    return 'N94-' + slug + '-' + (seq < 10 ? '0' : '') + seq;
  }

  /**
   * Match a parsed reply to one of the notices.
   * @param mail     result of parseEml
   * @param notices  [{ ref, emails: [..], status }]
   * @returns { notice, method: 'ref'|'sender'|'none'|'ambiguous', candidates }
   */
  function matchReply(mail, notices) {
    // 1. Mail threading: the reply points at the Message-ID of the notice we sent.
    var h = mail.headers || {};
    var thread = (h['in-reply-to'] || '') + ' ' + (h.references || '');
    if (thread.trim()) {
      var byThread = notices.filter(function (n) { return n.messageId && thread.indexOf(n.messageId) >= 0; })[0];
      if (byThread) return { notice: byThread, method: 'thread', candidates: [byThread] };
    }
    // 2. The notice reference (N94-…) in the subject or body.
    var refs = ((mail.subject || '') + '\n' + (mail.text || '')).match(REF_RE) || [];
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i].toUpperCase();
      var hit = notices.filter(function (n) { return String(n.ref).toUpperCase() === r; })[0];
      if (hit) return { notice: hit, method: 'ref', candidates: [hit] };
    }
    var from = String(mail.fromEmail || '').toLowerCase();
    var fromDomain = from.split('@')[1] || '';
    var bySender = notices.filter(function (n) { return (n.emails || []).indexOf(from) >= 0; });
    if (!bySender.length && fromDomain) {
      bySender = notices.filter(function (n) { return (n.emails || []).some(function (e) { return e.split('@')[1] === fromDomain; }); });
    }
    var open = bySender.filter(function (n) { return n.status !== 'closed'; });
    var pool = open.length ? open : bySender;
    if (pool.length === 1) return { notice: pool[0], method: 'sender', candidates: pool };
    if (pool.length > 1) return { notice: null, method: 'ambiguous', candidates: pool };
    return { notice: null, method: 'none', candidates: [] };
  }

  return {
    base64: base64,
    unbase64: unbase64,
    buildEml: buildEml,
    parseEml: parseEml,
    decodeWords: decodeWords,
    noticeRef: noticeRef,
    matchReply: matchReply,
    REF_RE: REF_RE
  };
});
