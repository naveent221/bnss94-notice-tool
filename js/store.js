/*
 * BNSS94 Notice Tool — local case store (IndexedDB, on this computer only).
 *
 * Stores:  cases  (key: firNo)   case details, NCRP rows, selections, notices, replies
 *          files  (key: id)      FIR copies and reply attachments (bytes)
 *          meta   (key: key)     nodal-officer directory and other shared data
 *
 * If IndexedDB is unavailable (some private windows / locked-down browsers)
 * everything is kept in memory for this page only, and `persistent` is false.
 * Nothing here touches the network.
 */
(function (root) {
  'use strict';
  var DB_NAME = 'bnss94', DB_VERSION = 1, STORES = { cases: 'firNo', files: 'id', meta: 'key' };
  var db = null, mem = { cases: {}, files: {}, meta: {} }, ready;

  function openDb() {
    return new Promise(function (resolve) {
      var req;
      try { req = root.indexedDB && root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { req = null; }
      if (!req) return resolve(null);
      req.onupgradeneeded = function () {
        var d = req.result;
        Object.keys(STORES).forEach(function (s) { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: STORES[s] }); });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function init() {
    if (!ready) ready = openDb().then(function (d) { db = d; Store.persistent = !!d; return Store; });
    return ready;
  }

  function tx(store, mode, fn) {
    return init().then(function () {
      if (!db) return fn(null);
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode), os = t.objectStore(store), result;
        var r = fn(os);
        if (r && 'onsuccess' in r) r.onsuccess = function () { result = r.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('Storage error')); };
      });
    });
  }

  function clone(v) { return v; } // structured clone happens inside IndexedDB; memory mode keeps references

  var Store = {
    persistent: false,
    init: init,
    get: function (store, key) {
      return tx(store, 'readonly', function (os) { return os ? os.get(key) : null; })
        .then(function (r) { return db ? r : mem[store][key]; });
    },
    getAll: function (store) {
      return tx(store, 'readonly', function (os) { return os ? os.getAll() : null; })
        .then(function (r) { return db ? (r || []) : Object.keys(mem[store]).map(function (k) { return mem[store][k]; }); });
    },
    put: function (store, value) {
      return tx(store, 'readwrite', function (os) { if (os) return os.put(value); mem[store][value[STORES[store]]] = clone(value); return null; });
    },
    del: function (store, key) {
      return tx(store, 'readwrite', function (os) { if (os) return os.delete(key); delete mem[store][key]; return null; });
    },

    /** Everything as one JSON-safe object (file bytes as base64). */
    exportAll: function (b64) {
      return Promise.all([Store.getAll('cases'), Store.getAll('files'), Store.getAll('meta')]).then(function (r) {
        return {
          format: 'bnss94-backup', version: 1, exportedAt: new Date().toISOString(),
          cases: r[0],
          files: r[1].map(function (f) { var o = Object.assign({}, f); o.data = b64(f.data); o.encoding = 'base64'; return o; }),
          meta: r[2]
        };
      });
    },

    /** Restore a backup. Existing cases with the same FIR number are replaced only if `overwrite`. */
    importAll: function (obj, unb64, overwrite) {
      if (!obj || obj.format !== 'bnss94-backup') return Promise.reject(new Error('Not a BNSS94 backup file'));
      return Store.getAll('cases').then(function (existing) {
        var have = {}, added = 0, skipped = 0;
        existing.forEach(function (c) { have[c.firNo] = true; });
        var jobs = [];
        (obj.cases || []).forEach(function (c) {
          if (have[c.firNo] && !overwrite) { skipped++; return; }
          added++; jobs.push(Store.put('cases', c));
        });
        (obj.files || []).forEach(function (f) {
          var o = Object.assign({}, f); o.data = f.encoding === 'base64' ? unb64(f.data) : f.data; delete o.encoding;
          jobs.push(Store.put('files', o));
        });
        (obj.meta || []).forEach(function (m) { jobs.push(Store.put('meta', m)); });
        return Promise.all(jobs).then(function () { return { added: added, skipped: skipped }; });
      });
    }
  };

  root.BNSSStore = Store;
})(typeof self !== 'undefined' ? self : this);
