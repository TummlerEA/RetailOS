/*
 * RetailOS — store master data and monthly targets.
 *
 * Plain HTML, CSS and JavaScript. No frameworks, no build step, no
 * dependencies. Everything lives in one browser's localStorage for now;
 * every read and write goes through the Data adapter below so that swapping
 * in a server later is a change in one place rather than everywhere.
 *
 * Records carry `updatedAt` and deletions leave a tombstone, so merging two
 * copies is order-independent: the newer version of each record wins and a
 * deletion travels with it. That is what makes sync possible later, and it
 * is what makes "restore a backup" safe today.
 */
(function () {
  "use strict";

  var VERSION = 11;

  var K = {
    stores:   "retailos-stores",
    targets:  "retailos-targets",
    settings: "retailos-settings",
    mapping:  "retailos-import-mapping",
    session:  "retailos-session"
  };

  var CHANNELS = ["Retail", "Outlet", "Concession", "Franchise", "Ecommerce", "Pop-up"];

  // The name over the door. Separate from channel on purpose: a Nike store
  // can be full-price, an outlet, or a concession, and both questions get
  // asked. "Multi" is a store carrying several of these brands.
  var BRANDS = ["Multi", "Asics", "Under Armour", "Levis", "Nike"];

  // The six targets, in the order they appear everywhere.
  //   Transactions = Traffic x Conversion
  //   Units        = Transactions x UPT
  //   Sales        = Units x ASP
  //   SOT          = Sales / Traffic  ( = Conversion x UPT x ASP )
  // so none of the six is independent of the others. `driver` marks the four
  // that multiply out to sales; SOT falls out of sales and traffic.
  var METRICS = [
    { key: "sales",      label: "Sales",      kind: "money",   dp: 0 },
    { key: "traffic",    label: "Traffic",    kind: "count",   dp: 0, driver: true },
    { key: "conversion", label: "Conversion", kind: "percent", dp: 2, driver: true },
    { key: "upt",        label: "UPT",        kind: "ratio",   dp: 2, driver: true },
    { key: "asp",        label: "ASP",        kind: "money",   dp: 2, driver: true },
    { key: "sot",        label: "SOT",        kind: "money",   dp: 2 }
  ];

  var METRIC_KEYS = METRICS.map(function (m) { return m.key; });

  // Entered sales is flagged when it drifts this far from what the four
  // drivers imply. A percent is generous enough not to nag about rounding.
  var VARIANCE_TOLERANCE = 0.01;

  var MONTH_NAMES = ["january", "february", "march", "april", "may", "june",
                     "july", "august", "september", "october", "november", "december"];

  /* ═══════════════════ small helpers ═══════════════════ */

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function nowIso() { return new Date().toISOString(); }

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Quota, or Safari private browsing. Say so rather than losing the
      // edit silently — the person can still export what is on screen.
      toast("Could not save — storage is full or blocked.");
      return false;
    }
  }

  // Numbers arrive from Excel with thousands separators, currency symbols,
  // stray spaces and the occasional (1,234) for a negative.
  function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return isFinite(value) ? value : null;
    var text = String(value).trim();
    if (!text || text === "-" || text === "—") return null;
    var negative = /^\(.*\)$/.test(text);
    text = text.replace(/[()]/g, "");
    var percent = text.indexOf("%") >= 0;
    text = text.replace(/[^0-9.,\-+eE]/g, "");
    // 1.234,56 (continental) vs 1,234.56 — decide by which separator is last.
    var lastComma = text.lastIndexOf(",");
    var lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) text = text.replace(/\./g, "").replace(",", ".");
      else text = text.replace(/,/g, "");
    } else if (lastComma >= 0) {
      // A lone comma is a decimal point if it splits off one or two digits.
      text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "");
    }
    var n = parseFloat(text);
    if (!isFinite(n)) return null;
    if (negative) n = -n;
    if (percent) n = n / 100;
    return n;
  }

  function round(n, dp) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    var f = Math.pow(10, dp);
    return Math.round(n * f) / f;
  }

  function fmt(value, metric) {
    if (value === null || value === undefined || value === "") return "";
    if (metric && metric.kind === "percent") return (value * 100).toFixed(metric.dp) + "%";
    var dp = metric ? metric.dp : 2;
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  function escapeCsv(value) {
    if (value === null || value === undefined) return "";
    var text = String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  var toastTimer = null;
  function toast(message) {
    var node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 3200);
  }

  /* ═══════════════════ months ═══════════════════ */
  // Everything is keyed on a calendar month as "YYYY-MM". A retail 4-5-4
  // calendar would need a period table behind this; the key is deliberately
  // opaque to the rest of the app so that change stays contained here.

  function monthKey(year, monthIndex) {
    return year + "-" + (monthIndex + 1 < 10 ? "0" : "") + (monthIndex + 1);
  }

  function monthLabel(key) {
    var parts = String(key).split("-");
    var index = parseInt(parts[1], 10) - 1;
    if (isNaN(index) || index < 0 || index > 11) return key;
    var name = MONTH_NAMES[index];
    return name.charAt(0).toUpperCase() + name.slice(1, 3) + " " + parts[0];
  }

  function thisMonth() {
    var d = new Date();
    return monthKey(d.getFullYear(), d.getMonth());
  }

  function shiftMonth(key, delta) {
    var parts = String(key).split("-");
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1 + delta, 1);
    return monthKey(d.getFullYear(), d.getMonth());
  }

  // Excel stores a date as days since 1899-12-30 (its leap-year bug included).
  function excelSerialToDate(serial) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  }

  /*
   * Reads a month from whatever a spreadsheet happens to hold. Returns
   * { key } on success, or { error } saying what was wrong — a header the
   * app cannot read must say so in the preview rather than being dropped.
   * `defaultYear` rescues a bare "Mar" or "3"; without one they are refused.
   */
  function parseMonth(value, defaultYear) {
    if (value === null || value === undefined || value === "") return { error: "empty" };

    if (value instanceof Date && !isNaN(value)) {
      return { key: monthKey(value.getUTCFullYear(), value.getUTCMonth()) };
    }

    // A number here is either an Excel date serial or a YYYYMM.
    if (typeof value === "number" && isFinite(value)) {
      if (value >= 190001 && value <= 210012 && String(Math.round(value)).length === 6) {
        return parseMonth(String(Math.round(value)), defaultYear);
      }
      if (value > 20000 && value < 80000) {
        var d = excelSerialToDate(value);
        return { key: monthKey(d.getUTCFullYear(), d.getUTCMonth()) };
      }
      if (value >= 1 && value <= 12) {
        if (!defaultYear) return { error: "month number with no year" };
        return { key: monthKey(defaultYear, Math.round(value) - 1) };
      }
      return { error: "not a month" };
    }

    var text = String(value).trim();
    if (!text) return { error: "empty" };
    var m;

    // 2026-03, 2026/03, 2026-03-01
    m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(text);
    if (m) return finishMonth(parseInt(m[1], 10), parseInt(m[2], 10));

    // 202603
    m = /^(\d{4})(\d{2})$/.exec(text);
    if (m) return finishMonth(parseInt(m[1], 10), parseInt(m[2], 10));

    // 03/2026, 3-2026
    m = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
    if (m) return finishMonth(parseInt(m[2], 10), parseInt(m[1], 10));

    // 01.08.2026, 01/08/2026, 1-8-26 — a whole date where the year comes
    // last. Day first, as written everywhere outside the United States.
    // Only the month is kept; which day of it was named does not matter.
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
    if (m) {
      var first = parseInt(m[1], 10);
      var second = parseInt(m[2], 10);
      var year = parseInt(m[3], 10);
      if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
      // Day first unless the numbers say otherwise: past the 12th, a value
      // cannot be a month, so a file written the American way still reads
      // correctly rather than silently landing in the wrong month.
      var month = first > 12 ? second : (second > 12 ? first : second);
      return finishMonth(year, month);
    }

    // Mar-26, March 2026, Mar 26, Mar.26
    m = /^([A-Za-z]{3,9})[\s\-./]*(\d{2}|\d{4})?$/.exec(text);
    if (m) {
      var index = monthNameIndex(m[1]);
      if (index < 0) return { error: "not a month name" };
      if (!m[2]) {
        if (!defaultYear) return { error: "no year — set the year to assume" };
        return { key: monthKey(defaultYear, index) };
      }
      var year = parseInt(m[2], 10);
      if (m[2].length === 2) year += year < 70 ? 2000 : 1900;
      return finishMonth(year, index + 1);
    }

    // 26-Mar, 2026 March
    m = /^(\d{2}|\d{4})[\s\-./]+([A-Za-z]{3,9})$/.exec(text);
    if (m) {
      var i2 = monthNameIndex(m[2]);
      if (i2 < 0) return { error: "not a month name" };
      var y2 = parseInt(m[1], 10);
      if (m[1].length === 2) y2 += y2 < 70 ? 2000 : 1900;
      return finishMonth(y2, i2 + 1);
    }

    return { error: "unreadable month" };
  }

  function finishMonth(year, month) {
    if (!(year >= 1900 && year <= 2100)) return { error: "year out of range" };
    if (!(month >= 1 && month <= 12)) return { error: "month out of range" };
    return { key: monthKey(year, month - 1) };
  }

  // "mar", "March", "Sept" — a prefix of the month's name, three letters or more.
  function monthNameIndex(name) {
    var lower = String(name).toLowerCase();
    if (lower.length < 3) return -1;
    for (var i = 0; i < 12; i++) if (MONTH_NAMES[i].indexOf(lower) === 0) return i;
    return -1;
  }

  /* ═══════════════════ data ═══════════════════
   *
   * One adapter interface, two eventual implementations. Only LocalAdapter
   * exists today; a Supabase-backed one slots in behind the same methods
   * without the screens knowing. Everything is synchronous for now, but the
   * screens call it through Data.* only, so making these return promises
   * later touches this file in one region.
   */

  var LocalAdapter = {
    name: "local",

    stores: function () {
      var list = readJson(K.stores, []);
      return Array.isArray(list) ? list : [];
    },

    targets: function () {
      var list = readJson(K.targets, []);
      return Array.isArray(list) ? list : [];
    },

    putStores: function (list) { return writeJson(K.stores, list); },
    putTargets: function (list) { return writeJson(K.targets, list); }
  };

  // Every local write returns through here, so there is one place that
  // knows a change also has to reach the server. When nobody is signed in
  // it does nothing, which is the whole of the offline story.
  function saved(ok) { Sync.schedule(); return ok; }

  var Data = {
    adapter: LocalAdapter,

    /* ── stores ── */

    liveStores: function () {
      return Data.adapter.stores()
        .filter(function (s) { return s && !s.deleted; })
        .sort(function (a, b) { return String(a.storeId).localeCompare(String(b.storeId), undefined, { numeric: true }); });
    },

    storeById: function (id) {
      var all = Data.adapter.stores();
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].storeId === id && !all[i].deleted) return all[i];
      }
      return null;
    },

    saveStore: function (record) {
      var all = Data.adapter.stores();
      var next = Object.assign({}, record, { updatedAt: nowIso() });
      delete next.deleted;
      var found = false;
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].storeId === next.storeId) { all[i] = next; found = true; break; }
      }
      if (!found) all.push(next);
      return saved(Data.adapter.putStores(all));
    },

    // A tombstone keeps only what is needed to propagate the deletion.
    deleteStore: function (id) {
      var all = Data.adapter.stores();
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].storeId === id) {
          all[i] = { storeId: id, deleted: true, updatedAt: nowIso() };
        }
      }
      return saved(Data.adapter.putStores(all));
    },

    /* ── targets ── */

    targetKey: function (storeId, month) { return storeId + "|" + month; },

    liveTargets: function () {
      return Data.adapter.targets().filter(function (t) { return t && !t.deleted; });
    },

    targetFor: function (storeId, month) {
      var key = Data.targetKey(storeId, month);
      var all = Data.adapter.targets();
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].id === key && !all[i].deleted) return all[i];
      }
      return null;
    },

    // Writes one metric on one store-month. An empty value clears the field;
    // a row left with no values at all becomes a tombstone rather than an
    // empty shell, so it does not travel as a change on every future merge.
    setTargetValue: function (storeId, month, metricKey, value) {
      var all = Data.adapter.targets();
      var key = Data.targetKey(storeId, month);
      var index = -1;
      for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === key) { index = i; break; }

      var record = index >= 0 && !all[index].deleted
        ? Object.assign({}, all[index])
        : { id: key, storeId: storeId, month: month };

      if (value === null || value === undefined || value === "") delete record[metricKey];
      else record[metricKey] = value;

      var hasAny = METRIC_KEYS.some(function (k) {
        return record[k] !== undefined && record[k] !== null;
      });
      record.updatedAt = nowIso();
      if (!hasAny) record = { id: key, storeId: storeId, month: month, deleted: true, updatedAt: record.updatedAt };
      else delete record.deleted;

      if (index >= 0) all[index] = record; else all.push(record);
      return saved(Data.adapter.putTargets(all));
    },

    // Bulk upsert used by import. Each incoming row is { storeId, month, ...metrics }
    // and is merged field by field, so a file carrying only Traffic does not
    // wipe the Sales already recorded for that month.
    upsertTargets: function (rows) {
      var all = Data.adapter.targets();
      var byKey = {};
      all.forEach(function (t, i) { if (t && t.id) byKey[t.id] = i; });
      var stamp = nowIso();

      rows.forEach(function (row) {
        var key = Data.targetKey(row.storeId, row.month);
        var index = byKey[key];
        var record = index !== undefined && !all[index].deleted
          ? Object.assign({}, all[index])
          : { id: key, storeId: row.storeId, month: row.month };
        METRIC_KEYS.forEach(function (k) {
          if (row[k] !== undefined && row[k] !== null) record[k] = row[k];
        });
        record.updatedAt = stamp;
        delete record.deleted;
        if (index !== undefined) all[index] = record;
        else { byKey[key] = all.length; all.push(record); }
      });

      return saved(Data.adapter.putTargets(all));
    },

    upsertStores: function (rows) {
      var all = Data.adapter.stores();
      var byId = {};
      all.forEach(function (s, i) { if (s && s.storeId) byId[s.storeId] = i; });
      var stamp = nowIso();

      rows.forEach(function (row) {
        var index = byId[row.storeId];
        var record = index !== undefined && !all[index].deleted
          ? Object.assign({}, all[index])
          : { storeId: row.storeId };
        Object.keys(row).forEach(function (k) {
          if (row[k] !== undefined && row[k] !== null && row[k] !== "") record[k] = row[k];
        });
        record.updatedAt = stamp;
        delete record.deleted;
        if (index !== undefined) all[index] = record;
        else { byId[row.storeId] = all.length; all.push(record); }
      });

      return saved(Data.adapter.putStores(all));
    },

    /* ── months in use ── */

    knownMonths: function () {
      var seen = {};
      Data.liveTargets().forEach(function (t) { if (t.month) seen[t.month] = true; });
      var list = Object.keys(seen).sort();
      if (!list.length) list = [thisMonth()];
      return list;
    },

    /* ── settings ── */

    settings: function () {
      var s = readJson(K.settings, {});
      return {
        currency: s.currency || "GBP",
        variance: s.variance !== false
      };
    },

    saveSettings: function (patch) {
      var next = Object.assign(Data.settings(), patch);
      return writeJson(K.settings, next);
    },

    /* ── whole-file export and merge-restore ── */

    exportDocument: function () {
      return {
        format: "retailos",
        formatVersion: 1,
        exportedAt: nowIso(),
        settings: Data.settings(),
        stores: Data.adapter.stores(),
        targets: Data.adapter.targets()
      };
    },

    // Merges rather than replaces: the newer version of each record wins,
    // in either direction, so the order two files are applied in cannot
    // change the result and an old backup cannot resurrect a deletion.
    mergeDocument: function (doc) {
      if (!doc || doc.format !== "retailos") throw new Error("Not a RetailOS backup.");
      var result = { stores: 0, targets: 0 };

      result.stores = mergeById(Data.adapter.stores(), doc.stores, "storeId", Data.adapter.putStores);
      result.targets = mergeById(Data.adapter.targets(), doc.targets, "id", Data.adapter.putTargets);
      Sync.schedule();
      return result;
    }
  };

  function mergeById(mine, theirs, idField, put) {
    if (!Array.isArray(theirs)) return 0;
    var byId = {};
    mine.forEach(function (r, i) { if (r && r[idField]) byId[r[idField]] = i; });
    var changed = 0;

    theirs.forEach(function (incoming) {
      if (!incoming || !incoming[idField]) return;
      var index = byId[incoming[idField]];
      if (index === undefined) {
        byId[incoming[idField]] = mine.length;
        mine.push(incoming);
        changed++;
        return;
      }
      var existing = mine[index];
      var a = String(existing.updatedAt || "");
      var b = String(incoming.updatedAt || "");
      if (b > a) { mine[index] = incoming; changed++; }
    });

    put(mine);
    return changed;
  }

  /* ═══════════════════ the server ═══════════════════
   *
   * The app stays local-first. Every screen still reads and writes the
   * browser copy synchronously, exactly as it did before this existed, so
   * nothing above had to be rewritten and the phone keeps working with no
   * signal.
   *
   * Sync is a separate, occasional errand: pull what the server has, merge
   * it in by the same last-write-wins rule two backup files use, then push
   * whatever turned out to be newer here. Because the merge is
   * order-independent, it does not matter which device syncs first, or how
   * long one of them was offline.
   */

  function isoOrNull(value) {
    if (!value) return null;
    var when = new Date(value);
    return isNaN(when.getTime()) ? null : when.toISOString();
  }

  function blankToNull(value) {
    return value === undefined || value === null || value === "" ? null : value;
  }

  function numberOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    var n = typeof value === "number" ? value : toNumber(value);
    return n === null || n === undefined || isNaN(n) ? null : n;
  }

  /* ── translating between the two shapes ──
   *
   * The browser copy is camelCase with the month as "2026-03" and missing
   * values simply absent. Postgres is snake_case with the month a real date
   * and missing values null. Every column is sent on every push, nulls
   * included: leaving a key out would mean "unchanged", and clearing a
   * target has to travel too.
   */

  function storeToRemote(record) {
    return {
      store_id: record.storeId,
      // A tombstone carries no name and the column cannot be empty. The ID
      // is the honest stand-in.
      store_name: blankToNull(record.storeName) || record.storeId,
      store_manager: blankToNull(record.storeManager),
      store_channel: blankToNull(record.storeChannel),
      store_brand: blankToNull(record.storeBrand),
      country: blankToNull(record.country),
      status: blankToNull(record.status) || "active",
      open_date: blankToNull(record.openDate),
      close_date: blankToNull(record.closeDate),
      sales_area: numberOrNull(record.salesArea),
      address: blankToNull(record.address),
      latitude: blankToNull(record.latitude),
      longitude: blankToNull(record.longitude),
      updated_at: isoOrNull(record.updatedAt) || nowIso(),
      deleted: !!record.deleted
    };
  }

  function storeFromRemote(row) {
    var record = { storeId: row.store_id, updatedAt: isoOrNull(row.updated_at) || nowIso() };
    if (row.deleted) { record.deleted = true; return record; }
    [["storeName", "store_name"], ["storeManager", "store_manager"],
     ["storeChannel", "store_channel"], ["storeBrand", "store_brand"],
     ["country", "country"], ["status", "status"],
     ["openDate", "open_date"], ["closeDate", "close_date"],
     ["address", "address"], ["latitude", "latitude"], ["longitude", "longitude"]].forEach(function (pair) {
      var value = row[pair[1]];
      if (value !== null && value !== undefined && value !== "") record[pair[0]] = value;
    });
    if (row.sales_area !== null && row.sales_area !== undefined) record.salesArea = Number(row.sales_area);
    return record;
  }

  function targetToRemote(record) {
    var row = {
      store_id: record.storeId,
      month: record.month + "-01",
      updated_at: isoOrNull(record.updatedAt) || nowIso(),
      deleted: !!record.deleted
    };
    METRIC_KEYS.forEach(function (key) { row[key] = record.deleted ? null : numberOrNull(record[key]); });
    return row;
  }

  function targetFromRemote(row) {
    var month = String(row.month || "").slice(0, 7);
    var record = {
      id: Data.targetKey(row.store_id, month),
      storeId: row.store_id,
      month: month,
      updatedAt: isoOrNull(row.updated_at) || nowIso()
    };
    if (row.deleted) { record.deleted = true; return record; }
    METRIC_KEYS.forEach(function (key) {
      if (row[key] !== null && row[key] !== undefined) record[key] = Number(row[key]);
    });
    return record;
  }

  // Rows this device holds a newer version of than the server does. Run
  // after the pull has been merged in, so anything still newer here is
  // genuinely a local change the server has not seen.
  function newerHere(mine, theirs, idField) {
    var seen = {};
    theirs.forEach(function (row) {
      if (row && row[idField]) seen[row[idField]] = String(row.updatedAt || "");
    });
    return mine.filter(function (row) {
      if (!row || !row[idField]) return false;
      var remote = seen[row[idField]];
      return remote === undefined || String(row.updatedAt || "") > remote;
    });
  }

  var Remote = {
    config: function () {
      var c = (typeof window !== "undefined" && window.RETAILOS_CONFIG) || {};
      return c.supabaseUrl && c.supabasePublishableKey ? c : null;
    },

    configured: function () { return !!Remote.config(); },

    session: function () {
      var s = readJson(K.session, null);
      return s && s.accessToken ? s : null;
    },

    setSession: function (session) {
      if (!session) { try { localStorage.removeItem(K.session); } catch (e) { /* nothing useful to do */ } return true; }
      return writeJson(K.session, session);
    },

    signedIn: function () { return !!Remote.session(); },

    email: function () { var s = Remote.session(); return s ? s.email || "" : ""; },

    // Both grants return the same shape, so signing in and refreshing an
    // expired token are the same call with a different body.
    token: function (grant, body) {
      var c = Remote.config();
      if (!c) return Promise.reject(new Error("No Supabase project is configured."));
      return fetch(c.supabaseUrl + "/auth/v1/token?grant_type=" + grant, {
        method: "POST",
        headers: { apikey: c.supabasePublishableKey, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = parseMaybeJson(text);
          if (!res.ok) throw new Error(authMessage(res.status, data));
          if (!data || !data.access_token) throw new Error("The server replied without a token.");
          return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || "",
            email: (data.user && data.user.email) || (body.email || Remote.email()),
            expiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString()
          };
        });
      });
    },

    signIn: function (email, password) {
      return Remote.token("password", { email: email, password: password }).then(function (session) {
        Remote.setSession(session);
        return session;
      });
    },

    refresh: function () {
      var current = Remote.session();
      if (!current || !current.refreshToken) return Promise.reject(new Error("Signed out. Sign in again."));
      return Remote.token("refresh_token", { refresh_token: current.refreshToken }).then(function (session) {
        Remote.setSession(session);
        return session;
      }, function (e) {
        // A refresh token the server no longer honours means the session is
        // over. Clearing it is what puts the sign-in form back.
        Remote.setSession(null);
        throw e;
      });
    },

    signOut: function () {
      var c = Remote.config();
      var current = Remote.session();
      Remote.setSession(null);
      if (!c || !current) return Promise.resolve();
      // Best effort: the local session is already gone either way.
      return fetch(c.supabaseUrl + "/auth/v1/logout", {
        method: "POST",
        headers: { apikey: c.supabasePublishableKey, Authorization: "Bearer " + current.accessToken }
      }).then(function () { return true; }, function () { return true; });
    },

    request: function (path, options, retried) {
      var c = Remote.config();
      var session = Remote.session();
      if (!c) return Promise.reject(new Error("No Supabase project is configured."));
      if (!session) return Promise.reject(new Error("Sign in first."));
      var opts = options || {};

      var headers = { apikey: c.supabasePublishableKey, Authorization: "Bearer " + session.accessToken, "Content-Type": "application/json" };
      Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });

      return fetch(c.supabaseUrl + "/rest/v1/" + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body
      }).then(function (res) {
        // An hour-old access token is the ordinary case, not an error.
        if (res.status === 401 && !retried && session.refreshToken) {
          return Remote.refresh().then(function () { return Remote.request(path, options, true); });
        }
        return res.text().then(function (text) {
          var data = parseMaybeJson(text);
          if (!res.ok) throw new Error(restMessage(res.status, data));
          return data;
        });
      });
    },

    upsert: function (table, rows) {
      var chunks = [];
      for (var i = 0; i < rows.length; i += 400) chunks.push(rows.slice(i, i + 400));
      return chunks.reduce(function (chain, chunk) {
        return chain.then(function () {
          return Remote.request(table, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(chunk)
          });
        });
      }, Promise.resolve());
    }
  };

  function parseMaybeJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return { message: String(text).slice(0, 200) }; }
  }

  function authMessage(status, data) {
    if (status === 400 || status === 401) return "That email and password did not match.";
    if (status === 422) return "Enter an email address and a password.";
    if (status === 429) return "Too many attempts. Wait a minute and try again.";
    var said = data && (data.error_description || data.msg || data.message || data.error);
    return said || ("Sign-in failed (" + status + ").");
  }

  function restMessage(status, data) {
    var said = data && (data.message || data.hint || data.error);
    if (status === 401 || status === 403) {
      return "The server refused that. " + (said || "This account may not have access to the tables.");
    }
    if (said && data.details) return said + " — " + data.details;
    return said || ("The server replied " + status + ".");
  }

  var Sync = {
    inFlight: null,
    pending: null,
    owed: false,
    lastError: "",
    lastSyncedAt: "",
    // What this device holds that the server does not, as of the last
    // attempt. Without it a failed push is invisible unless someone opens
    // Settings and reads the error.
    behind: { stores: 0, targets: 0 },

    // Called after every local write. Waits a moment so that typing a row
    // of six targets is one sync rather than six.
    //
    // A write that lands while a sync is already running cannot join it —
    // that round has already decided what to push. It must not be dropped
    // either: doing so lost whole imports, because applying one import
    // starts a sync and applying the next a second later fell inside it.
    // So it is remembered, and another round runs when this one ends.
    schedule: function () {
      if (!Remote.signedIn()) return;
      if (Sync.inFlight) { Sync.owed = true; return; }
      if (Sync.pending) clearTimeout(Sync.pending);
      Sync.pending = setTimeout(function () {
        Sync.pending = null;
        Sync.now().catch(function () { /* the error is already on the screen */ });
      }, 1500);
    },

    // The merge inside a sync writes locally through the adapter rather
    // than through saved(), so it never owes itself a round.
    settle: function () {
      if (!Sync.owed) return;
      Sync.owed = false;
      Sync.schedule();
    },

    now: function () {
      if (Sync.inFlight) return Sync.inFlight;
      if (!Remote.signedIn()) return Promise.resolve(null);

      var result = { pulled: 0, pushed: 0 };
      Sync.lastError = "";
      onSyncStateChanged();

      Sync.inFlight = Promise.all([
        Remote.request("stores?select=*"),
        Remote.request("targets?select=*")
      ]).then(function (both) {
        var stores = (both[0] || []).map(storeFromRemote);
        var targets = (both[1] || []).map(targetFromRemote);

        result.pulled =
          mergeById(Data.adapter.stores(), stores, "storeId", Data.adapter.putStores) +
          mergeById(Data.adapter.targets(), targets, "id", Data.adapter.putTargets);

        var pushStores = newerHere(Data.adapter.stores(), stores, "storeId");
        var pushTargets = newerHere(Data.adapter.targets(), targets, "id");
        result.pushed = pushStores.length + pushTargets.length;

        // Stores go first, because a target cannot reference a store the
        // server has not been told about yet. But a store the server
        // refuses must not take the targets down with it: they are separate
        // tables, and one bad store row used to mean no target ever
        // reached the server at all, with nothing on screen to say so.
        var outcome = { stores: 0, targets: 0, failures: [] };

        function why(e) { return e && e.message ? e.message : String(e); }

        return (pushStores.length ? Remote.upsert("stores", pushStores.map(storeToRemote)) : Promise.resolve())
          .then(function () { outcome.stores = pushStores.length; },
                function (e) { outcome.failures.push("Stores — " + why(e)); })
          .then(function () {
            return pushTargets.length ? Remote.upsert("targets", pushTargets.map(targetToRemote)) : Promise.resolve();
          })
          .then(function () { outcome.targets = pushTargets.length; },
                function (e) { outcome.failures.push("Targets — " + why(e)); })
          .then(function () {
            result.pushed = outcome.stores + outcome.targets;
            Sync.behind = {
              stores: pushStores.length - outcome.stores,
              targets: pushTargets.length - outcome.targets
            };
            if (outcome.failures.length) throw new Error(outcome.failures.join("  ·  "));
          });
      }).then(function () {
        Sync.behind = { stores: 0, targets: 0 };
        Sync.lastSyncedAt = nowIso();
        Sync.inFlight = null;
        onSyncStateChanged(result);
        Sync.settle();
        return result;
      }, function (e) {
        Sync.lastError = e && e.message ? e.message : String(e);
        Sync.inFlight = null;
        onSyncStateChanged();
        // Still owed even though this round failed: the next one carries
        // both its changes and these.
        Sync.settle();
        throw e;
      });

      onSyncStateChanged();
      return Sync.inFlight;
    }
  };

  /* ═══════════════════ the maths between the targets ═══════════════════
   *
   * Sales = Traffic x Conversion x UPT x ASP. All six are editable, because
   * that is how target-setting actually happens — a sales number lands first
   * and the drivers get backfilled — but where both sides are present and
   * they disagree, the app says so rather than quietly picking a winner.
   */

  function isNum(v) { return v !== null && v !== undefined && v !== "" && isFinite(v); }

  function impliedSales(target) {
    if (!target) return null;
    var t = target.traffic, c = target.conversion, u = target.upt, a = target.asp;
    if (![t, c, u, a].every(isNum)) return null;
    return t * c * u * a;
  }

  function impliedSot(target) {
    if (!target || !isNum(target.sales) || !isNum(target.traffic) || target.traffic === 0) return null;
    return target.sales / target.traffic;
  }

  function oneCheck(label, implied, stated, metric) {
    var ratio = stated === 0 ? null : (implied - stated) / Math.abs(stated);
    return {
      label: label,
      implied: implied,
      stated: stated,
      ratio: ratio,
      metric: metric,
      off: ratio === null ? implied !== stated : Math.abs(ratio) > VARIANCE_TOLERANCE
    };
  }

  // Every check the six numbers can be held to. Only those with both sides
  // present are returned — a half-filled row is incomplete, not wrong.
  function checksFor(target) {
    var out = [];
    if (!target) return out;

    var sales = impliedSales(target);
    if (sales !== null && isNum(target.sales)) {
      out.push(oneCheck("Sales", sales, target.sales, METRICS[0]));
    }
    var sot = impliedSot(target);
    if (sot !== null && isNum(target.sot)) {
      out.push(oneCheck("SOT", sot, target.sot, METRICS[5]));
    }
    return out;
  }

  /* ═══════════════════ reading spreadsheets ═══════════════════
   *
   * An .xlsx is a ZIP of XML, and every current browser can inflate a raw
   * DEFLATE stream on its own (DecompressionStream). So reading one needs
   * no library: unzip the three parts that matter, parse them with the
   * DOMParser that is already there, and hand back rows of cells. That
   * keeps this app dependency-free, which is the whole point of it.
   *
   * Old browsers without DecompressionStream fall back to the CSV and
   * paste-from-Excel paths, which cover the same ground with more steps.
   */

  function findEocd(view, length) {
    var back = Math.min(length, 66000);
    for (var i = length - 22; i >= length - back && i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function zipEntries(buffer) {
    var view = new DataView(buffer);
    var bytes = new Uint8Array(buffer);
    var decoder = new TextDecoder();
    var eocd = findEocd(view, buffer.byteLength);
    if (eocd < 0) throw new Error("That does not look like an .xlsx file.");

    var count = view.getUint16(eocd + 10, true);
    var start = view.getUint32(eocd + 16, true);
    if (start === 0xFFFFFFFF || count === 0xFFFF) {
      throw new Error("This workbook uses the Zip64 format, which this app cannot read. Save it as CSV.");
    }

    var entries = {};
    var p = start;
    for (var n = 0; n < count && p + 46 <= buffer.byteLength; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, compSize: compSize, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries, view: view, bytes: bytes };
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("This browser cannot open .xlsx files. Save the sheet as CSV, or paste the cells instead."));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer();
  }

  // Returns the entry's text, or null when the workbook has no such part
  // (sharedStrings.xml is genuinely absent from a sheet of pure numbers).
  function zipRead(zip, name) {
    var entry = zip.entries[name];
    if (!entry) return Promise.resolve(null);
    var headerAt = entry.localOffset;
    var nameLen = zip.view.getUint16(headerAt + 26, true);
    var extraLen = zip.view.getUint16(headerAt + 28, true);
    var from = headerAt + 30 + nameLen + extraLen;
    var slice = zip.bytes.subarray(from, from + entry.compSize);
    if (entry.method === 0) return Promise.resolve(new TextDecoder().decode(slice));
    if (entry.method !== 8) return Promise.reject(new Error("Unsupported compression inside the workbook."));
    return inflateRaw(slice).then(function (buf) { return new TextDecoder().decode(new Uint8Array(buf)); });
  }

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("The workbook's XML is damaged.");
    return doc;
  }

  function colIndex(ref) {
    var i = 0, n = 0;
    var text = String(ref).toUpperCase();
    while (i < text.length && text[i] >= "A" && text[i] <= "Z") {
      n = n * 26 + (text.charCodeAt(i) - 64);
      i++;
    }
    return n - 1;
  }

  // Which style indexes mean "this number is a date". Only enough of the
  // number-format machinery to tell a date from a plain number, which is
  // all a month header needs.
  function dateStyles(stylesXml) {
    var isDate = {};
    if (!stylesXml) return isDate;
    var doc;
    try { doc = parseXml(stylesXml); } catch (e) { return isDate; }

    var custom = {};
    var formats = doc.getElementsByTagName("numFmt");
    for (var i = 0; i < formats.length; i++) {
      var id = formats[i].getAttribute("numFmtId");
      var code = String(formats[i].getAttribute("formatCode") || "");
      var bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
      if (/[ymd]/i.test(bare)) custom[id] = true;
    }

    var xfsBlocks = doc.getElementsByTagName("cellXfs");
    if (!xfsBlocks.length) return isDate;
    var xfs = xfsBlocks[0].getElementsByTagName("xf");
    for (var j = 0; j < xfs.length; j++) {
      var fmtId = xfs[j].getAttribute("numFmtId") || "0";
      var n = parseInt(fmtId, 10);
      if (custom[fmtId] || (n >= 14 && n <= 22) || (n >= 45 && n <= 47)) isDate[j] = true;
    }
    return isDate;
  }

  function sharedStringList(xml) {
    if (!xml) return [];
    var doc = parseXml(xml);
    var items = doc.getElementsByTagName("si");
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var runs = items[i].getElementsByTagName("t");
      var text = "";
      for (var j = 0; j < runs.length; j++) text += runs[j].textContent;
      out.push(text);
    }
    return out;
  }

  function sheetRows(xml, strings, isDate) {
    var doc = parseXml(xml);
    var rowNodes = doc.getElementsByTagName("row");
    var rows = [];

    for (var i = 0; i < rowNodes.length; i++) {
      var cells = rowNodes[i].getElementsByTagName("c");
      var row = [];
      for (var j = 0; j < cells.length; j++) {
        var cell = cells[j];
        var at = colIndex(cell.getAttribute("r") || "");
        if (at < 0) at = row.length;
        var type = cell.getAttribute("t") || "n";
        var value = null;

        if (type === "inlineStr") {
          var ts = cell.getElementsByTagName("t");
          var s = "";
          for (var k = 0; k < ts.length; k++) s += ts[k].textContent;
          value = s;
        } else {
          var vNodes = cell.getElementsByTagName("v");
          var raw = vNodes.length ? vNodes[0].textContent : "";
          if (raw === "") value = null;
          else if (type === "s") value = strings[parseInt(raw, 10)] || "";
          else if (type === "str") value = raw;
          else if (type === "b") value = raw === "1";
          else if (type === "e") value = null;
          else {
            var n = parseFloat(raw);
            value = isFinite(n) ? n : null;
            var styleIndex = cell.getAttribute("s");
            if (value !== null && styleIndex !== null && isDate[parseInt(styleIndex, 10)] && value > 0) {
              value = excelSerialToDate(value);
            }
          }
        }
        while (row.length < at) row.push(null);
        row[at] = value;
      }
      // Excel omits empty rows entirely; the r attribute says where we are.
      var rowAt = parseInt(rowNodes[i].getAttribute("r") || "0", 10) - 1;
      if (rowAt >= 0) { while (rows.length < rowAt) rows.push([]); rows[rowAt] = row; }
      else rows.push(row);
    }
    return rows;
  }

  function readWorkbook(buffer) {
    var zip = zipEntries(buffer);
    return Promise.all([
      zipRead(zip, "xl/workbook.xml"),
      zipRead(zip, "xl/_rels/workbook.xml.rels"),
      zipRead(zip, "xl/sharedStrings.xml"),
      zipRead(zip, "xl/styles.xml")
    ]).then(function (parts) {
      if (!parts[0]) throw new Error("The workbook has no sheets this app can read.");
      var book = parseXml(parts[0]);
      var rels = {};
      if (parts[1]) {
        var relNodes = parseXml(parts[1]).getElementsByTagName("Relationship");
        for (var i = 0; i < relNodes.length; i++) {
          rels[relNodes[i].getAttribute("Id")] = relNodes[i].getAttribute("Target");
        }
      }
      var strings = sharedStringList(parts[2]);
      var isDate = dateStyles(parts[3]);

      var sheetNodes = book.getElementsByTagName("sheet");
      var jobs = [];
      for (var j = 0; j < sheetNodes.length; j++) {
        var name = sheetNodes[j].getAttribute("name") || ("Sheet" + (j + 1));
        var rid = sheetNodes[j].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
               || sheetNodes[j].getAttribute("r:id");
        var target = rels[rid] || ("worksheets/sheet" + (j + 1) + ".xml");
        var path = target.charAt(0) === "/" ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
        jobs.push(readOneSheet(zip, path, name, strings, isDate));
      }
      return Promise.all(jobs);
    });
  }

  function readOneSheet(zip, path, name, strings, isDate) {
    return zipRead(zip, path).then(function (xml) {
      return { name: name, rows: xml ? sheetRows(xml, strings, isDate) : [] };
    }, function () {
      return { name: name, rows: [] };
    });
  }

  /* ── delimited text ── */

  function sniffDelimiter(text) {
    var head = text.split(/\r?\n/).slice(0, 5).join("\n");
    var counts = { "\t": 0, ",": 0, ";": 0 };
    var inQuotes = false;
    for (var i = 0; i < head.length; i++) {
      var ch = head[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && counts[ch] !== undefined) counts[ch]++;
    }
    var best = "\t";
    Object.keys(counts).forEach(function (d) { if (counts[d] > counts[best]) best = d; });
    return counts[best] === 0 ? "," : best;
  }

  function parseDelimited(text, delimiter) {
    var d = delimiter || sniffDelimiter(text);
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    text = text.replace(/^﻿/, "");

    while (i < text.length) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
      if (ch === d) { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ""; });
    });
  }

  /* ═══════════════════ import ═══════════════════
   *
   * Nothing here writes. It turns a grid of cells into proposed rows, works
   * out for each one whether it is new, a change or already the same, and
   * hands that back for the preview to render. Applying it is a separate,
   * deliberate step — and because every write is an upsert keyed on the
   * store (or the store and month), importing the same file twice is a
   * no-op the second time rather than a pile of duplicates.
   */

  // Each field's synonyms are the headers seen in the wild, English first
  // and Russian after it. Nothing here is a guess about what a column
  // means: an unrecognised header is reported as ignored rather than
  // matched approximately.
  var STORE_FIELDS = [
    { key: "storeId",      label: "Store ID",   required: true,
      syn: ["storeid", "store", "storeno", "storenumber", "storecode", "shopid", "shopno", "id", "code", "branch", "branchid", "branchno",
            "кодмагазина", "код", "идмагазина", "номермагазина", "кодтт", "идтт"] },
    { key: "storeName",    label: "Name",
      syn: ["storename", "name", "shopname", "branchname", "description", "location", "sitename",
            "магазин", "названиемагазина", "наименование", "наименованиемагазина", "названиеточки", "торговаяточка", "тт"] },
    { key: "storeManager", label: "Manager",
      syn: ["storemanager", "manager", "storemgr", "mgr", "managername", "sm",
            "менеджер", "управляющий", "директормагазина", "директор", "руководитель", "управляющиймагазином"] },
    { key: "storeChannel", label: "Channel",
      syn: ["storechannel", "channel", "storetype", "type", "format", "storeformat", "concept",
            "канал", "каналпродаж", "типмагазина", "формат", "форматмагазина"] },
    { key: "storeBrand",   label: "Brand",
      syn: ["storebrand", "brand", "fascia", "banner", "marque", "brandname", "label",
            "бренд", "марка", "вывеска", "торговаямарка", "брендмагазина"] },
    { key: "country",      label: "Country",
      syn: ["country", "market", "countrycode", "страна", "рынок"] },
    { key: "status",       label: "Status",
      syn: ["status", "state", "active", "статус", "состояние"] },
    { key: "openDate",     label: "Opened",
      syn: ["opendate", "opened", "openingdate", "dateopened", "датаоткрытия", "открытие"] },
    { key: "closeDate",    label: "Closed",
      syn: ["closedate", "closed", "closingdate", "dateclosed", "датазакрытия", "закрытие"] },
    { key: "salesArea",    label: "Sales area",
      syn: ["salesarea", "area", "sqm", "m2", "sellingarea", "sellingspace", "size", "squaremetres", "squaremeters",
            "площадь", "торговаяплощадь", "площадьторговая", "квм", "м2", "площадьмагазина"] },
    { key: "address",      label: "Address",
      syn: ["address", "streetaddress", "street", "addressline1", "addr", "postaladdress", "fulladdress", "location",
            "адрес", "адресмагазина", "фактическийадрес", "улица"] },
    { key: "latitude",     label: "Latitude",
      syn: ["latitude", "lat", "y", "geolat", "storelatitude", "широта"] },
    { key: "longitude",    label: "Longitude",
      syn: ["longitude", "long", "lng", "lon", "x", "geolong", "storelongitude", "долгота"] }
  ];

  var METRIC_SYN = {
    sales:      ["salestarget", "sales", "salestgt", "targetsales", "turnover", "revenue", "netsales", "netsalestarget", "value", "salesvalue",
                 "продажи", "продажа", "выручка", "оборот", "товарооборот", "суммапродаж", "планпродаж", "продажиплан", "объемпродаж"],
    traffic:    ["traffictarget", "traffic", "footfall", "footfalltarget", "visitors", "entries", "counter", "trafficgoal",
                 "trafic", "traffik", "trafik", "traffictgt", "footfal", "traficktarget", "trafictarget",
                 "трафик", "трафикплан", "посетители", "посещаемость", "поток", "входящийпоток", "количествопосетителей", "проходимость"],
    conversion: ["conversiontarget", "conversion", "conv", "convrate", "conversionrate", "cr", "convtarget", "cvr",
                 "конверсия", "конверсияплан", "коэффициентконверсии", "конверсиямагазина"],
    upt:        ["upttarget", "upt", "unitspertransaction", "unitspertxn", "ipt", "itemspertransaction", "uptgoal",
                 "упт", "штуквчеке", "единицвчеке", "количествовчеке", "товароввчеке", "глубиначека"],
    // Deliberately not "средний чек": that is the average transaction
    // value, which is ASP x UPT, not ASP. Mapping it here would drop a
    // number about half again too big into a column the checks then flag.
    asp:        ["asptarget", "asp", "averagesellingprice", "avgsellingprice", "avgprice", "averageprice", "aur", "asptgt",
                 "средняяцена", "средняяценатовара", "ценазаединицу", "средняяценапродажи", "среднаяцена"],
    sot:        ["sottarget", "sot", "sottgt", "sotgoal",
                 "сот", "продажинапосетителя", "выручканапосетителя", "доходнапосетителя"]
  };

  var MONTH_SYN = ["month", "period", "yearmonth", "ym", "date", "monthkey", "calendarmonth", "per",
                   "месяц", "период", "дата", "месяцгод", "отчетныйпериод", "напериод"];
  var METRIC_COL_SYN = ["metric", "kpi", "measure", "target", "targettype", "indicator",
                        "показатель", "метрика", "измерение", "планпоказатель"];

  // Strips a header down to letters and digits so that spacing, case and
  // punctuation stop mattering. Letters means letters in any script: the
  // old version kept only a-z, which quietly reduced every Cyrillic header
  // to an empty string — and, since the store search runs through here too,
  // made searching by a Russian store name match everything rather than
  // filtering.
  function normHeader(text) {
    return String(text === null || text === undefined ? "" : text)
      .toLowerCase()
      .replace(/\u00b2/g, "2")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function matchField(header, fields) {
    var norm = normHeader(header);
    if (!norm) return null;
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].syn.indexOf(norm) >= 0) return fields[i].key;
    }
    return null;
  }

  function matchMetric(header) {
    var norm = normHeader(header);
    if (!norm) return null;
    var keys = Object.keys(METRIC_SYN);
    for (var i = 0; i < keys.length; i++) {
      if (METRIC_SYN[keys[i]].indexOf(norm) >= 0) return keys[i];
    }
    return null;
  }

  /*
   * Decides what a grid of cells is. Target files from a business are
   * usually wide — stores down the side, months across the top — because
   * that is how they are built and reviewed; asking for them unpivoted
   * first is how a tool stops being used.
   */
  function detectLayout(rows, defaultYear) {
    if (!rows.length) return { kind: "empty" };
    var header = rows[0] || [];

    var monthCols = [];
    var storeIdCol = -1;
    var monthCol = -1;
    var metricCol = -1;
    var metricCols = {};
    var storeFieldCols = {};
    var ignored = [];

    for (var c = 0; c < header.length; c++) {
      var cell = header[c];
      if (cell === null || cell === undefined || String(cell).trim() === "") continue;
      var norm = normHeader(cell);

      var storeKey = matchField(cell, STORE_FIELDS);
      if (storeKey) {
        if (storeKey === "storeId" && storeIdCol < 0) storeIdCol = c;
        if (storeFieldCols[storeKey] === undefined) storeFieldCols[storeKey] = c;
        continue;
      }
      if (MONTH_SYN.indexOf(norm) >= 0 && monthCol < 0) { monthCol = c; continue; }
      if (METRIC_COL_SYN.indexOf(norm) >= 0 && metricCol < 0) { metricCol = c; continue; }

      var metric = matchMetric(cell);
      if (metric && metricCols[metric] === undefined) { metricCols[metric] = c; continue; }

      var asMonth = parseMonth(cell, defaultYear);
      if (asMonth.key) { monthCols.push({ at: c, month: asMonth.key }); continue; }

      ignored.push(String(cell));
    }

    var base = {
      storeIdCol: storeIdCol, monthCol: monthCol, metricCol: metricCol,
      metricCols: metricCols, monthCols: monthCols,
      storeFieldCols: storeFieldCols, ignored: ignored
    };

    if (monthCols.length >= 2) return Object.assign(base, { kind: "targets-wide" });
    if (monthCol >= 0 && (Object.keys(metricCols).length || metricCol >= 0)) {
      return Object.assign(base, { kind: "targets-long" });
    }
    if (storeIdCol >= 0 && Object.keys(storeFieldCols).length >= 2) {
      return Object.assign(base, { kind: "stores" });
    }
    if (monthCols.length === 1) return Object.assign(base, { kind: "targets-wide" });
    return Object.assign(base, { kind: "unknown" });
  }

  function cleanText(value) {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).trim();
  }

  function cleanDate(value) {
    if (value === null || value === undefined || value === "") return "";
    if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
    if (typeof value === "number" && value > 20000 && value < 80000) {
      return excelSerialToDate(value).toISOString().slice(0, 10);
    }
    var text = String(value).trim();
    var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
    if (m) return m[1] + "-" + pad2(m[2]) + "-" + pad2(m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (m) return m[3] + "-" + pad2(m[2]) + "-" + pad2(m[1]); // day first, as the UK writes it
    return "";
  }

  function pad2(n) { n = String(parseInt(n, 10)); return n.length < 2 ? "0" + n : n; }

  // Kept as text so the precision given survives untouched, but only if it
  // really is a coordinate. Excel hands these over as numbers as often as
  // strings, and people paste "55.7446675° N" — the degree sign and the
  // hemisphere letter are dropped, N and E being positive already.
  function cleanCoordinate(value, limit) {
    var text = cleanText(value);
    if (!text) return null;
    var negative = /[SW]\s*$/i.test(text) || /^\s*-/.test(text);
    var digits = text.replace(/[^0-9.]/g, "");
    if (!digits || !/^[0-9]+(\.[0-9]+)?$/.test(digits)) return null;
    var size = Number(digits);
    if (isNaN(size) || size > limit) return null;
    return (negative ? "-" : "") + digits;
  }

  function matchBrand(value) {
    var norm = normHeader(value);
    if (!norm) return "";
    for (var i = 0; i < BRANDS.length; i++) {
      if (normHeader(BRANDS[i]) === norm) return BRANDS[i];
    }
    var aliases = { ua: "Under Armour", underarmor: "Under Armour", underarmour: "Under Armour",
                    levi: "Levis", levistrauss: "Levis",
                    multibrand: "Multi", mixed: "Multi", multibrandstore: "Multi",
                    nikestore: "Nike", asicsstore: "Asics",
                    "мульти": "Multi", "мультибренд": "Multi", "мультибрендовый": "Multi",
                    "найк": "Nike", "асикс": "Asics", "левайс": "Levis", "левис": "Levis",
                    "андерармор": "Under Armour", "андерармур": "Under Armour" };
    return aliases[norm] || "";
  }

  function matchChannel(value) {
    var norm = normHeader(value);
    if (!norm) return "";
    for (var i = 0; i < CHANNELS.length; i++) {
      if (normHeader(CHANNELS[i]) === norm) return CHANNELS[i];
    }
    var aliases = { ol: "Outlet", fo: "Outlet", factoryoutlet: "Outlet", conc: "Concession",
                    shopinshop: "Concession", sis: "Concession", franchisee: "Franchise",
                    ecom: "Ecommerce", online: "Ecommerce", web: "Ecommerce", digital: "Ecommerce",
                    popup: "Pop-up", temporary: "Pop-up", fullprice: "Retail", own: "Retail",
                    doors: "Retail", flagship: "Retail",
                    "розница": "Retail", "розничный": "Retail", "собственный": "Retail", "флагман": "Retail",
                    "аутлет": "Outlet", "сток": "Outlet", "дисконт": "Outlet",
                    "концессия": "Concession", "островок": "Concession", "остров": "Concession", "шопвшопе": "Concession",
                    "франшиза": "Franchise", "франчайзинг": "Franchise", "франчайзи": "Franchise",
                    "интернетмагазин": "Ecommerce", "онлайн": "Ecommerce", "электроннаяторговля": "Ecommerce",
                    "попап": "Pop-up", "временный": "Pop-up", "временныймагазин": "Pop-up" };
    return aliases[norm] || "";
  }

  /*
   * Turns a numeric cell into a stored value, or explains why it cannot.
   * Conversion is the awkward one: Excel hands over 0.23, 23 and "23%" from
   * three different files for the same thing, so anything above 1 is read as
   * percentage points and the preview says that it was.
   */
  // A spreadsheet says "nothing here" with a dash as often as with an empty
  // cell. Treating that as a broken number turned whole rows into errors
  // for a value that was never meant to be there.
  function isBlank(raw) {
    var text = String(raw).trim().toLowerCase();
    return text === "" || /^[-–—]+$/.test(text) ||
           text === "n/a" || text === "na" || text === "#n/a" || text === "нет" || text === "б/д";
  }

  function readMetric(metricKey, raw) {
    if (raw === null || raw === undefined || isBlank(raw)) return { value: null };
    var n = toNumber(raw);
    if (n === null) return { error: '"' + String(raw).slice(0, 24) + '" is not a number' };

    if (metricKey === "conversion") {
      if (n < 0) return { error: "conversion below zero" };
      // Left exactly as written. Whether a value above 1 means a rate or
      // percentage points is decided per row once the rest of it is known —
      // see settleConversion.
      return { value: round(n, 6) };
    }
    if (n < 0 && metricKey !== "sot") return { error: metricKey + " below zero" };
    return { value: round(n, 6) };
  }

  // 0.075 is unambiguous. 7.5 is not: it could be a 7.5% conversion written
  // in percentage points, or a genuine 750%. Dividing everything above 1 by
  // 100 was wrong — a store whose counter under-reports really can sell to
  // more people than it counted, and four rows of real data did.
  //
  // The row usually settles it itself, because Sales = Traffic x Conversion
  // x UPT x ASP: whichever reading reproduces the stated sales is the one
  // that was meant. Only when the row cannot answer does the old assumption
  // apply, and then it is reported.
  function settleConversion(row) {
    var c = row.conversion;
    if (c === undefined || c === null || c <= 1) return null;

    var others = row.traffic && row.upt && row.asp && row.sales;
    if (others) {
      var asRate = Math.abs(row.traffic * c * row.upt * row.asp - row.sales);
      var asPoints = Math.abs(row.traffic * (c / 100) * row.upt * row.asp - row.sales);
      if (asRate <= asPoints) return null;          // it means what it says
      row.conversion = round(c / 100, 6);
      return "read as percentage points";
    }

    row.conversion = round(c / 100, 6);
    return "read as percentage points";
  }

  /* ── building proposals ── */

  function buildStoreRows(rows, layout) {
    var out = [];
    var known = {};
    var notes = {};

    // A channel or brand outside its vocabulary used to be written through
    // as typed. The database refuses those, so the import looked fine and
    // the sync failed later with a constraint error nowhere near the cause.
    // Left blank and counted instead: the store still comes in, and the
    // preview says how many need a value choosing.
    function fromVocabulary(key, raw, matched) {
      if (matched) return matched;
      var text = cleanText(raw);
      if (!text) return "";
      var label = key === "storeChannel" ? "channel" : "brand";
      var note = 'values were not a ' + label + ' this app knows, and were left blank';
      notes[note] = (notes[note] || 0) + 1;
      return "";
    }
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var id = cleanText(row[layout.storeIdCol]);
      if (!id) {
        if (row.some(function (c) { return cleanText(c) !== ""; })) {
          out.push({ bad: "No store ID on this row", raw: describeRow(row) });
        }
        continue;
      }
      if (known[id]) { out.push({ bad: "Store ID " + id + " appears twice in this file", raw: id }); continue; }
      known[id] = true;

      var record = { storeId: id };
      Object.keys(layout.storeFieldCols).forEach(function (key) {
        if (key === "storeId") return;
        var raw = row[layout.storeFieldCols[key]];
        if (key === "openDate" || key === "closeDate") record[key] = cleanDate(raw);
        else if (key === "salesArea") { var n = toNumber(raw); if (n !== null) record[key] = n; }
        else if (key === "latitude" || key === "longitude") {
          var coord = cleanCoordinate(raw, key === "latitude" ? 90 : 180);
          if (coord !== null) record[key] = coord;
        }
        else if (key === "storeChannel") record[key] = fromVocabulary(key, raw, matchChannel(raw));
        else if (key === "storeBrand") record[key] = fromVocabulary(key, raw, matchBrand(raw));
        else if (key === "status") record[key] = normaliseStatus(raw);
        else record[key] = cleanText(raw);
      });

      if (!record.storeName) { out.push({ bad: "Store " + id + " has no name", raw: id }); continue; }
      out.push({ row: record });
    }
    return { items: out, notes: notes };
  }

  function normaliseStatus(raw) {
    var norm = normHeader(raw);
    if (!norm) return "";
    if (["active", "open", "trading", "yes", "y", "true", "1",
         "активный", "активен", "действующий", "работает", "открыт", "да"].indexOf(norm) >= 0) return "active";
    if (["closed", "shut", "no", "n", "false", "0",
         "закрыт", "закрытый", "закрыто", "нет"].indexOf(norm) >= 0) return "closed";
    if (["pipeline", "planned", "future", "notopenyet",
         "план", "впланах", "планируется", "будущий", "воткрытии"].indexOf(norm) >= 0) return "pipeline";
    return "";
  }

  function describeRow(row) {
    return row.map(cleanText).filter(Boolean).slice(0, 3).join(" · ") || "(blank)";
  }

  // The store list, indexed both ways: by ID to check a target's key and
  // to look its name up, and by name for files that carry only a name.
  function storeIndex(list) {
    var byId = {};
    var byName = {};
    (list || []).forEach(function (store) {
      if (!store || !store.storeId) return;
      byId[store.storeId] = store.storeName || "";
      var norm = normHeader(store.storeName);
      if (!norm) return;
      if (!byName[norm]) byName[norm] = [];
      byName[norm].push(store.storeId);
    });
    return { byId: byId, byName: byName };
  }

  function buildTargetRows(rows, layout, defaultYear, chosenMetric, stores) {
    var out = [];
    var seen = {};
    var notes = {};
    var index = stores && stores.byId ? stores : storeIndex([]);
    var firstRow = {};
    var reported = {};
    var nameCol = layout.storeFieldCols ? layout.storeFieldCols.storeName : undefined;

    function record(storeId, month, metricKey, raw, label, atRow) {
      var read = readMetric(metricKey, raw);
      if (read.error) { out.push({ bad: storeId + " " + monthLabel(month) + ": " + read.error, raw: label }); return; }
      if (read.value === null) return;
      if (read.note) notes[read.note] = (notes[read.note] || 0) + 1;
      var key = storeId + "|" + month;
      if (!seen[key]) {
        seen[key] = { storeId: storeId, month: month };
        firstRow[key] = atRow;
        out.push({ row: seen[key] });
      } else if (firstRow[key] !== atRow && !reported[key]) {
        // The same store-month twice in one file, with different numbers,
        // is a re-cut someone forgot to remove. Silently keeping the last
        // one is how a file loses half a month.
        reported[key] = true;
        notes["store-months appear more than once in this file — the last value in the file wins"] =
          (notes["store-months appear more than once in this file — the last value in the file wins"] || 0) + 1;
      }
      seen[key][metricKey] = read.value;
    }

    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var id = layout.storeIdCol >= 0 ? cleanText(row[layout.storeIdCol]) : "";
      var named = nameCol !== undefined ? cleanText(row[nameCol]) : "";


      // A file with no ID column can still be placed, as long as the name
      // picks out exactly one store. Two stores sharing a name is not
      // something to resolve by guessing.
      if (!id && named) {
        var byName = index.byName[normHeader(named)] || [];
        if (byName.length === 1) {
          id = byName[0];
        } else if (byName.length > 1) {
          out.push({ bad: 'More than one store is called "' + named + '" — the file needs a store ID column', raw: describeRow(row) });
          continue;
        } else {
          out.push({ bad: 'No store called "' + named + '" in the store list', raw: describeRow(row) });
          continue;
        }
      }

      if (!id) {
        if (row.some(function (c) { return cleanText(c) !== ""; })) {
          out.push({ bad: "No store ID on this row", raw: describeRow(row) });
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(index.byId, id)) {
        out.push({ bad: "Store " + id + " is not in the store list — import stores first", raw: describeRow(row) });
        continue;
      }

      // Both an ID and a name: the name is there to catch a mis-keyed ID,
      // so a disagreement stops the row rather than being written. Compared
      // loosely, so case, spacing and punctuation do not raise false alarms.
      if (named && layout.storeIdCol >= 0) {
        var onFile = index.byId[id];
        if (onFile && normHeader(onFile) !== normHeader(named)) {
          out.push({
            bad: 'Store ' + id + ' is "' + onFile + '" in the store list, not "' + named + '"',
            raw: describeRow(row)
          });
          continue;
        }
      }

      if (layout.kind === "targets-wide") {
        // A metric column lets one wide file carry several metrics stacked;
        // otherwise the whole grid is the one metric picked on screen.
        var metricKey = chosenMetric;
        if (layout.metricCol >= 0) {
          metricKey = matchMetric(row[layout.metricCol]);
          if (!metricKey) {
            out.push({ bad: 'Do not recognise the metric "' + cleanText(row[layout.metricCol]) + '"', raw: id });
            continue;
          }
        }
        if (!metricKey) { out.push({ bad: "No metric chosen for this grid", raw: id }); continue; }
        layout.monthCols.forEach(function (col) {
          record(id, col.month, metricKey, row[col.at], id + " " + monthLabel(col.month), r);
        });
      } else {
        var parsed = parseMonth(row[layout.monthCol], defaultYear);
        if (!parsed.key) {
          out.push({ bad: 'Month "' + cleanText(row[layout.monthCol]) + '" — ' + parsed.error, raw: id });
          continue;
        }
        if (layout.metricCol >= 0) {
          var mk = matchMetric(row[layout.metricCol]);
          if (!mk) { out.push({ bad: 'Do not recognise the metric "' + cleanText(row[layout.metricCol]) + '"', raw: id }); continue; }
          var valueCol = layout.metricCols[mk];
          if (valueCol === undefined) {
            var candidates = Object.keys(layout.metricCols);
            valueCol = candidates.length === 1 ? layout.metricCols[candidates[0]] : undefined;
          }
          if (valueCol === undefined) { out.push({ bad: "Cannot tell which column holds the value", raw: id }); continue; }
          record(id, parsed.key, mk, row[valueCol], id, r);
        } else {
          Object.keys(layout.metricCols).forEach(function (mk2) {
            record(id, parsed.key, mk2, row[layout.metricCols[mk2]], id, r);
          });
        }
      }
    }
    // Conversion is settled once the whole row is known, not cell by cell.
    out.forEach(function (item) {
      if (!item.row) return;
      var note = settleConversion(item.row);
      if (note) notes[note] = (notes[note] || 0) + 1;
    });

    return { items: out, notes: notes };
  }

  /* ── diffing against what is already stored ── */

  function diffStores(items) {
    var report = { adds: [], changes: [], same: 0, bad: [] };
    items.forEach(function (item) {
      if (item.bad) { report.bad.push(item); return; }
      var existing = Data.storeById(item.row.storeId);
      if (!existing) { report.adds.push({ row: item.row }); return; }
      var deltas = [];
      Object.keys(item.row).forEach(function (key) {
        if (key === "storeId") return;
        var to = item.row[key];
        if (to === "" || to === null || to === undefined) return;
        var from = existing[key];
        if (String(from === undefined || from === null ? "" : from) !== String(to)) {
          deltas.push({ field: key, from: from, to: to });
        }
      });
      if (deltas.length) report.changes.push({ row: item.row, deltas: deltas });
      else report.same++;
    });
    return report;
  }

  function diffTargets(items) {
    var report = { adds: [], changes: [], same: 0, bad: [] };
    items.forEach(function (item) {
      if (item.bad) { report.bad.push(item); return; }
      var existing = Data.targetFor(item.row.storeId, item.row.month);
      if (!existing) { report.adds.push({ row: item.row }); return; }
      var deltas = [];
      METRIC_KEYS.forEach(function (key) {
        if (item.row[key] === undefined) return;
        var from = existing[key];
        var to = item.row[key];
        if (from === undefined || from === null || Math.abs(from - to) > 1e-9) {
          deltas.push({ field: key, from: from, to: to });
        }
      });
      if (deltas.length) report.changes.push({ row: item.row, deltas: deltas });
      else report.same++;
    });
    return report;
  }

  /* ═══════════════════ screens ═══════════════════ */

  var ui = {};

  function showScreen(name) {
    ["stores", "targets", "import", "settings"].forEach(function (id) {
      $("screen-" + id).classList.toggle("is-active", id === name);
      $("tab-" + id).classList.toggle("is-active", id === name);
    });
    if (name === "stores") renderStores();
    if (name === "targets") renderTargets();
    if (name === "settings") renderSettings();
    setSubtitle();
  }

  function setSubtitle() {
    var stores = Data.liveStores().length;
    var targets = Data.liveTargets().length;
    $("topbar-sub").textContent = stores === 0
      ? "No stores yet — add one, or load a list on the Import tab."
      : stores + (stores === 1 ? " store" : " stores") + " · " + targets + " store-months of targets";

    var badge = $("mode-badge");
    if (!badge) return;
    badge.className = "badge";
    if (!Remote.signedIn()) {
      badge.textContent = "On this device";
      badge.title = "Data is saved in this browser only";
    } else if (Sync.inFlight) {
      badge.textContent = "Syncing…";
      badge.title = "Talking to the server";
    } else if (Sync.lastError || Sync.behind.stores || Sync.behind.targets) {
      badge.textContent = "Sync failed";
      badge.className = "badge is-warn";
      badge.title = Sync.lastError;
    } else {
      badge.textContent = "Synced";
      badge.className = "badge is-ok";
      badge.title = "Signed in as " + Remote.email();
    }
  }

  /* ── stores ── */

  function renderStores() {
    var query = normHeader($("store-search").value);
    var all = Data.liveStores();
    var list = query
      ? all.filter(function (s) {
          return normHeader(s.storeId + " " + s.storeName + " " + (s.storeManager || "")
                            + " " + (s.storeChannel || "") + " " + (s.storeBrand || "")).indexOf(query) >= 0;
        })
      : all;

    var host = $("store-list");
    host.textContent = "";
    $("store-count").textContent = all.length
      ? (query ? list.length + " of " + all.length + " stores" : all.length + (all.length === 1 ? " store" : " stores"))
      : "";

    if (!list.length) {
      var empty = el("p", "empty", all.length
        ? "Nothing matches that."
        : "No stores yet. Add one, or load your list on the Import tab.");
      host.appendChild(empty);
      return;
    }

    list.forEach(function (store) {
      var card = el("button", "card" + (store.status === "closed" ? " is-closed" : ""));
      card.type = "button";
      var top = el("div", "card-top");
      top.appendChild(el("span", "card-name", store.storeName || "(no name)"));
      top.appendChild(el("span", "card-id", store.storeId));
      card.appendChild(top);

      var bits = [];
      if (store.storeBrand) bits.push(store.storeBrand);
      if (store.storeChannel) bits.push(store.storeChannel);
      if (store.storeManager) bits.push(store.storeManager);
      if (store.country) bits.push(store.country);
      if (store.status === "closed") bits.push("Closed");
      if (store.status === "pipeline") bits.push("Pipeline");
      card.appendChild(el("div", "card-meta", bits.join(" · ") || "—"));

      card.addEventListener("click", function () { openStore(store.storeId); });
      host.appendChild(card);
    });
  }

  var editingStoreId = null;

  function openStore(id) {
    editingStoreId = id;
    var store = id ? Data.storeById(id) : null;

    $("store-dialog-title").textContent = store ? store.storeName || store.storeId : "New store";
    $("f-storeId").value = store ? store.storeId : "";
    $("f-storeId").readOnly = !!store;
    $("f-storeName").value = store ? (store.storeName || "") : "";
    $("f-storeManager").value = store ? (store.storeManager || "") : "";
    $("f-storeChannel").value = store ? (store.storeChannel || "") : "";
    $("f-storeBrand").value = store ? (store.storeBrand || "") : "";
    $("f-country").value = store ? (store.country || "") : "";
    $("f-openDate").value = store ? (store.openDate || "") : "";
    $("f-closeDate").value = store ? (store.closeDate || "") : "";
    $("f-salesArea").value = store && store.salesArea !== undefined ? store.salesArea : "";
    $("f-address").value = store ? (store.address || "") : "";
    $("f-latitude").value = store ? (store.latitude || "") : "";
    $("f-longitude").value = store ? (store.longitude || "") : "";
    $("f-status").value = store ? (store.status || "active") : "active";
    $("btn-delete-store").hidden = !store;
    $("store-error").hidden = true;
    $("store-dialog").showModal();
  }

  function saveStoreFromForm(event) {
    event.preventDefault();
    var id = $("f-storeId").value.trim();
    var name = $("f-storeName").value.trim();
    var error = $("store-error");

    if (!id) return failStore("A store needs an ID.");
    if (!name) return failStore("A store needs a name.");
    if (!editingStoreId && Data.storeById(id)) return failStore("Store " + id + " already exists.");

    var area = toNumber($("f-salesArea").value);
    var open = $("f-openDate").value;
    var close = $("f-closeDate").value;
    if (open && close && close < open) return failStore("The closing date is before the opening date.");

    Data.saveStore({
      storeId: id,
      storeName: name,
      storeManager: $("f-storeManager").value.trim(),
      storeChannel: $("f-storeChannel").value,
      storeBrand: $("f-storeBrand").value,
      country: $("f-country").value.trim(),
      openDate: open,
      closeDate: close,
      salesArea: area === null ? undefined : area,
      address: $("f-address").value.trim(),
      latitude: $("f-latitude").value.trim(),
      longitude: $("f-longitude").value.trim(),
      status: $("f-status").value
    });

    error.hidden = true;
    $("store-dialog").close();
    renderStores();
    setSubtitle();
    toast(editingStoreId ? "Saved" : "Store added");

    function failStore(message) {
      error.textContent = message;
      error.hidden = false;
      return false;
    }
  }

  function deleteCurrentStore() {
    if (!editingStoreId) return;
    var targets = Data.liveTargets().filter(function (t) { return t.storeId === editingStoreId; }).length;
    var warning = targets
      ? "Delete " + editingStoreId + "? Its " + targets + " months of targets stay in the data but stop showing."
      : "Delete " + editingStoreId + "?";
    if (!confirm(warning)) return;
    Data.deleteStore(editingStoreId);
    $("store-dialog").close();
    renderStores();
    setSubtitle();
    toast("Store deleted");
  }

  /* ── targets ── */

  // Conversion is stored as a fraction and shown as percentage points,
  // because nobody types 0.235 when they mean 23.5%.
  function toGrid(metric, stored) {
    if (stored === null || stored === undefined || stored === "") return "";
    return metric.kind === "percent" ? round(stored * 100, 4) : stored;
  }
  function fromGrid(metric, entered) {
    var n = toNumber(entered);
    if (n === null) return null;
    return metric.kind === "percent" ? round(n / 100, 6) : n;
  }

  function monthOptions() {
    var seen = {};
    var base = thisMonth();
    for (var i = -12; i <= 12; i++) seen[shiftMonth(base, i)] = true;
    Data.knownMonths().forEach(function (m) { seen[m] = true; });
    return Object.keys(seen).sort();
  }

  function fillSelect(select, values, labelFn, keep) {
    var previous = keep && values.indexOf(select.value) >= 0 ? select.value : null;
    select.textContent = "";
    values.forEach(function (v) {
      var option = el("option", null, labelFn ? labelFn(v) : v);
      option.value = v;
      select.appendChild(option);
    });
    if (previous) select.value = previous;
    return select.value;
  }

  function renderTargets() {
    var view = $("target-view").value;
    var stores = Data.liveStores().filter(function (s) { return s.status !== "closed"; });
    var months = monthOptions();

    fillSelect($("target-month"), months, monthLabel, true);
    fillSelect($("target-store"), stores.map(function (s) { return s.storeId; }),
      function (id) { var s = Data.storeById(id); return id + " — " + (s ? s.storeName : ""); }, true);

    $("target-month").hidden = view !== "by-month";
    $("target-store").hidden = view !== "by-store";

    var table = $("target-grid");
    table.textContent = "";

    var noStores = $("target-empty");
    noStores.hidden = stores.length > 0;
    table.parentNode.hidden = stores.length === 0;
    if (!stores.length) {
      $("target-summary").textContent = "";
      return;
    }

    var showChecks = $("chk-variance").checked;
    var settings = Data.settings();

    var rows = view === "by-month"
      ? stores.map(function (s) {
          return { storeId: s.storeId, month: $("target-month").value, label: s.storeName, sub: s.storeId };
        })
      : months.map(function (m) {
          return { storeId: $("target-store").value, month: m, label: monthLabel(m), sub: null };
        });

    /* header */
    var thead = el("thead");
    var hrow = el("tr");
    hrow.appendChild(el("th", "k", view === "by-month" ? "Store" : "Month"));
    METRICS.forEach(function (m) {
      var th = el("th", null, m.kind === "percent" ? m.label + " %" : m.label);
      if (m.key === "sot") th.title = "Sales ÷ Traffic, in " + settings.currency + " per visit";
      if (m.key === "asp") th.title = "Average selling price, " + settings.currency;
      hrow.appendChild(th);
    });
    if (showChecks) {
      var thc = el("th", null, "Check");
      thc.title = "Sales = Traffic × Conversion × UPT × ASP, and SOT = Sales ÷ Traffic";
      hrow.appendChild(thc);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    /* body */
    var tbody = el("tbody");
    var totals = { sales: 0, traffic: 0, transactions: 0, units: 0, anySales: false, anyTraffic: false };

    rows.forEach(function (spec) {
      var target = Data.targetFor(spec.storeId, spec.month) || {};
      var tr = el("tr");

      var key = el("td", "k");
      key.appendChild(document.createTextNode(spec.label || spec.storeId));
      if (spec.sub) key.appendChild(el("small", null, spec.sub));
      tr.appendChild(key);

      METRICS.forEach(function (metric) {
        var td = el("td");
        var input = el("input");
        input.type = "number";
        input.step = "any";
        input.value = toGrid(metric, target[metric.key]);
        input.setAttribute("aria-label", spec.label + " " + metric.label);
        input.dataset.storeId = spec.storeId;
        input.dataset.month = spec.month;
        input.dataset.metric = metric.key;
        input.addEventListener("change", onCellChange);
        td.appendChild(input);
        tr.appendChild(td);
      });

      if (showChecks) {
        var checks = checksFor(target);
        var bad = checks.filter(function (c) { return c.off; });
        var td2 = el("td", "var" + (bad.length ? " off" : (checks.length ? " ok" : "")));
        if (bad.length) {
          td2.textContent = bad.map(function (c) {
            return c.label + " " + (c.ratio === null ? "≠" : (c.ratio > 0 ? "+" : "") + (c.ratio * 100).toFixed(1) + "%");
          }).join(" · ");
          td2.title = bad.map(function (c) {
            return c.label + ": the numbers imply " + fmt(c.implied, c.metric) + ", you have " + fmt(c.stated, c.metric);
          }).join("\n");
        } else if (checks.length) {
          td2.textContent = "✓";
          td2.title = "Sales and SOT agree with the drivers.";
        } else {
          td2.textContent = "";
        }
        tr.appendChild(td2);
      }

      if (isNum(target.sales)) { totals.sales += target.sales; totals.anySales = true; }
      if (isNum(target.traffic)) {
        totals.traffic += target.traffic;
        totals.anyTraffic = true;
        if (isNum(target.conversion)) {
          var txn = target.traffic * target.conversion;
          totals.transactions += txn;
          if (isNum(target.upt)) totals.units += txn * target.upt;
        }
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    /* totals — weighted, never an average of averages */
    var tfoot = el("tfoot");
    var frow = el("tr");
    frow.appendChild(el("td", "k", "Total"));
    var footValues = {
      sales: totals.anySales ? totals.sales : null,
      traffic: totals.anyTraffic ? totals.traffic : null,
      conversion: totals.traffic ? totals.transactions / totals.traffic : null,
      upt: totals.transactions ? totals.units / totals.transactions : null,
      asp: totals.units ? totals.sales / totals.units : null,
      sot: totals.traffic ? totals.sales / totals.traffic : null
    };
    METRICS.forEach(function (m) {
      var v = footValues[m.key];
      frow.appendChild(el("td", null, v === null || !isFinite(v) ? "" : fmt(v, m)));
    });
    if (showChecks) frow.appendChild(el("td"));
    tfoot.appendChild(frow);
    table.appendChild(tfoot);

    $("target-summary").textContent = view === "by-month"
      ? "Percentages are weighted by traffic, not averaged. Values in " + settings.currency + "."
      : "All months for this store. Values in " + settings.currency + ".";
  }

  function onCellChange(event) {
    var input = event.target;
    var metric = METRICS.filter(function (m) { return m.key === input.dataset.metric; })[0];
    var value = input.value.trim() === "" ? null : fromGrid(metric, input.value);
    if (input.value.trim() !== "" && value === null) {
      toast("That is not a number.");
      input.value = "";
      return;
    }
    if (metric.key === "conversion" && value !== null && (value < 0 || value > 1)) {
      toast("Conversion has to be between 0 and 100%.");
      input.value = toGrid(metric, (Data.targetFor(input.dataset.storeId, input.dataset.month) || {})[metric.key]);
      return;
    }
    Data.setTargetValue(input.dataset.storeId, input.dataset.month, metric.key, value);
    renderTargets();
    setSubtitle();
  }

  // Excel's fill-down: the topmost value in each column drops into the empty
  // cells below it. It never overwrites anything already entered.
  function fillDown() {
    var inputs = Array.prototype.slice.call($("target-grid").querySelectorAll("tbody input"));
    var carried = {};
    var writes = 0;
    inputs.forEach(function (input) {
      var key = input.dataset.metric;
      if (input.value.trim() !== "") { carried[key] = input.value; return; }
      if (carried[key] === undefined) return;
      var metric = METRICS.filter(function (m) { return m.key === key; })[0];
      Data.setTargetValue(input.dataset.storeId, input.dataset.month, key, fromGrid(metric, carried[key]));
      writes++;
    });
    renderTargets();
    setSubtitle();
    toast(writes ? "Filled " + writes + " empty cells" : "Nothing to fill down");
  }

  /* ═══════════════════ the import screen ═══════════════════ */

  var importState = { sheets: null, sheetIndex: 0, rows: null, pending: null };

  function importYear() {
    var n = parseInt($("import-year").value, 10);
    return n >= 2000 && n <= 2100 ? n : null;
  }

  function clearImport() {
    importState = { sheets: null, sheetIndex: 0, rows: null, pending: null };
    $("import-paste").value = "";
    $("import-file").value = "";
    $("import-report").textContent = "";
    $("field-metric").hidden = true;
  }

  function onImportFile(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    var isExcel = /\.(xlsx|xlsm)$/i.test(file.name);
    var report = $("import-report");
    report.textContent = "";
    report.appendChild(el("p", "muted", "Reading " + file.name + "…"));

    if (!isExcel) {
      file.text().then(function (text) {
        importState.sheets = null;
        importState.rows = parseDelimited(text);
        runPreview();
      }, function () { importFailed("Could not read that file."); });
      return;
    }

    file.arrayBuffer()
      .then(readWorkbook)
      .then(function (sheets) {
        importState.sheets = sheets;
        importState.sheetIndex = chooseSheet(sheets, importYear());
        var chosen = sheets[importState.sheetIndex];
        importState.rows = chosen ? chosen.rows : [];
        runPreview();
      })
      .catch(function (error) { importFailed(error.message || "Could not read that workbook."); });
  }

  // The first sheet with rows on it is very often a cover note, so the one
  // to open is the first that reads as a store list or a set of targets —
  // falling back to the biggest sheet when none of them does.
  function chooseSheet(sheets, year) {
    var fallback = 0;
    var mostRows = -1;
    for (var i = 0; i < sheets.length; i++) {
      var rows = sheets[i].rows;
      if (rows.length < 2) continue;
      var kind = detectLayout(rows, year).kind;
      if (kind !== "unknown" && kind !== "empty") return i;
      if (rows.length > mostRows) { mostRows = rows.length; fallback = i; }
    }
    return fallback;
  }

  // A sheet the app cannot read must still leave the picker on screen —
  // otherwise landing on the wrong sheet of a workbook is a dead end.
  function importFailed(message) {
    var report = $("import-report");
    report.textContent = "";
    var box = el("div", "report");
    if (importState.sheets && importState.sheets.length > 1) box.appendChild(sheetPicker());
    box.appendChild(el("p", "error", message));
    report.appendChild(box);
  }

  function runPreview() {
    var report = $("import-report");
    report.textContent = "";

    var rows = importState.rows;
    if (!rows || !rows.length) {
      var pasted = $("import-paste").value;
      if (pasted.trim()) rows = importState.rows = parseDelimited(pasted);
    }
    if (!rows || rows.length < 2) {
      importFailed("Nothing to read yet — paste some cells including the header row, or pick a file.");
      return;
    }

    var year = importYear();
    var layout = detectLayout(rows, year);
    var forced = $("import-kind").value;
    if (forced === "stores" && layout.kind !== "stores") layout.kind = layout.storeIdCol >= 0 ? "stores" : layout.kind;
    if (forced === "targets" && layout.kind === "stores") {
      layout.kind = layout.monthCols.length ? "targets-wide" : "targets-long";
    }

    var wideNeedsMetric = layout.kind === "targets-wide" && layout.metricCol < 0;
    $("field-metric").hidden = !wideNeedsMetric;

    if (layout.kind === "empty" || layout.kind === "unknown") {
      importFailed("Cannot tell what these columns are. The first row must be headers — "
        + "a Store ID column plus either months across the top, or a Month column and one column per target.");
      return;
    }
    if (layout.kind !== "stores" && layout.monthCol < 0 && !layout.monthCols.length) {
      importFailed("No months found. Either put a Month column in, or head the value columns with the months themselves.");
      return;
    }
    if (layout.kind !== "stores" && layout.storeIdCol < 0) {
      importFailed("No Store ID column found. Name it 'Store ID', 'Store' or 'Store No'.");
      return;
    }

    var box = el("div", "report");
    if (importState.sheets && importState.sheets.length > 1) box.appendChild(sheetPicker());

    var summary, diff, notes = {};
    if (layout.kind === "stores") {
      var storesBuilt = buildStoreRows(rows, layout);
      diff = diffStores(storesBuilt.items);
      notes = storesBuilt.notes;
      summary = "Read as a store list — " + (rows.length - 1) + " rows.";
    } else {
      var built = buildTargetRows(rows, layout, year, $("import-metric").value,
                                  storeIndex(Data.liveStores()));
      diff = diffTargets(built.items);
      notes = built.notes;
      summary = layout.kind === "targets-wide"
        ? "Read as targets with months across the top — " + layout.monthCols.length + " months × " + (rows.length - 1) + " rows."
        : "Read as targets, one row per store-month — " + (rows.length - 1) + " rows.";
    }

    box.appendChild(el("p", "muted", summary));

    var tally = el("div", "tally");
    tally.appendChild(el("span", "pill add", diff.adds.length + " new"));
    tally.appendChild(el("span", "pill chg", diff.changes.length + " changed"));
    tally.appendChild(el("span", "pill", diff.same + " already the same"));
    if (diff.bad.length) tally.appendChild(el("span", "pill bad", diff.bad.length + " left out"));
    box.appendChild(tally);
    if (diff.bad.length) {
      box.appendChild(el("p", "muted",
        "A value that cannot be read is left out on its own — the rest of its row still comes in."));
    }

    Object.keys(notes).forEach(function (note) {
      box.appendChild(el("p", "muted", notes[note] + " values " + note + "."));
    });
    if (layout.ignored.length) {
      box.appendChild(el("p", "muted", "Columns ignored: " + layout.ignored.slice(0, 8).join(", ")
        + (layout.ignored.length > 8 ? " and " + (layout.ignored.length - 8) + " more" : "") + "."));
    }

    if (diff.adds.length || diff.changes.length) {
      box.appendChild(previewTable(layout.kind === "stores" ? "stores" : "targets", diff));
    }
    if (diff.bad.length) box.appendChild(rejectTable(diff.bad));

    var bar = el("div", "toolbar");
    var apply = el("button", "btn btn-primary", "Apply " + (diff.adds.length + diff.changes.length) + " changes");
    apply.type = "button";
    apply.disabled = !(diff.adds.length || diff.changes.length);
    apply.addEventListener("click", function () { applyImport(layout.kind === "stores" ? "stores" : "targets", diff); });
    bar.appendChild(apply);
    var cancel = el("button", "btn", "Discard");
    cancel.type = "button";
    cancel.addEventListener("click", clearImport);
    bar.appendChild(cancel);
    box.appendChild(bar);

    if (diff.same && !diff.adds.length && !diff.changes.length) {
      box.appendChild(el("p", "muted", "This file has already been imported — nothing would change."));
    }

    report.appendChild(box);
  }

  function sheetPicker() {
    var field = el("div", "field");
    var label = el("label", null, "Sheet");
    label.setAttribute("for", "import-sheet");
    field.appendChild(label);
    var select = el("select");
    select.id = "import-sheet";
    importState.sheets.forEach(function (sheet, i) {
      var option = el("option", null, sheet.name + " (" + sheet.rows.length + " rows)");
      option.value = String(i);
      select.appendChild(option);
    });
    select.value = String(importState.sheetIndex);
    select.addEventListener("change", function () {
      importState.sheetIndex = parseInt(select.value, 10);
      importState.rows = importState.sheets[importState.sheetIndex].rows;
      runPreview();
    });
    field.appendChild(select);
    return field;
  }

  function previewTable(kind, diff) {
    var wrap = el("div", "preview-wrap");
    var table = el("table", "preview");
    var columns = kind === "stores"
      ? ["Store", "What changes"]
      : ["Store", "Month", "What changes"];

    var thead = el("thead");
    var hrow = el("tr");
    columns.forEach(function (c) { hrow.appendChild(el("th", null, c)); });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el("tbody");
    var shown = 0;
    var LIMIT = 200;

    diff.adds.concat(diff.changes).forEach(function (item) {
      if (shown >= LIMIT) return;
      shown++;
      var isNew = !item.deltas;
      var tr = el("tr", isNew ? "row-add" : "row-chg");
      tr.appendChild(el("td", null, item.row.storeId));
      if (kind !== "stores") tr.appendChild(el("td", null, monthLabel(item.row.month)));

      var td = el("td");
      if (isNew) {
        td.textContent = kind === "stores"
          ? "New store: " + (item.row.storeName || "")
          : "New: " + METRIC_KEYS.filter(function (k) { return item.row[k] !== undefined; })
              .map(function (k) { return metricByKey(k).label + " " + fmt(item.row[k], metricByKey(k)); })
              .join(", ");
      } else {
        item.deltas.forEach(function (d, i) {
          if (i) td.appendChild(document.createTextNode(", "));
          var metric = metricByKey(d.field);
          var name = metric ? metric.label : (fieldLabel(d.field) || d.field);
          td.appendChild(document.createTextNode(name + " "));
          if (d.from !== undefined && d.from !== null && d.from !== "") {
            td.appendChild(el("span", "was", metric ? fmt(d.from, metric) : String(d.from)));
            td.appendChild(document.createTextNode(" → "));
          }
          td.appendChild(document.createTextNode(metric ? fmt(d.to, metric) : String(d.to)));
        });
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    if (diff.adds.length + diff.changes.length > LIMIT) {
      wrap.appendChild(el("p", "muted", "Showing the first " + LIMIT + ". Applying covers them all."));
    }
    return wrap;
  }

  function metricByKey(key) {
    for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i];
    return null;
  }
  function fieldLabel(key) {
    for (var i = 0; i < STORE_FIELDS.length; i++) if (STORE_FIELDS[i].key === key) return STORE_FIELDS[i].label;
    return null;
  }

  function rejectTable(bad) {
    var wrap = el("div", "preview-wrap");
    var table = el("table", "preview");
    var thead = el("thead");
    var hrow = el("tr");
    ["Row", "Why it was left out"].forEach(function (c) { hrow.appendChild(el("th", null, c)); });
    thead.appendChild(hrow);
    table.appendChild(thead);
    var tbody = el("tbody");
    bad.slice(0, 100).forEach(function (item) {
      var tr = el("tr", "row-bad");
      tr.appendChild(el("td", null, item.raw || ""));
      tr.appendChild(el("td", "why", item.bad));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (bad.length > 100) wrap.appendChild(el("p", "muted", (bad.length - 100) + " more not shown."));
    return wrap;
  }

  function applyImport(kind, diff) {
    var rows = diff.adds.concat(diff.changes).map(function (item) { return item.row; });
    if (!rows.length) return;
    if (kind === "stores") Data.upsertStores(rows);
    else Data.upsertTargets(rows);
    toast(rows.length + (rows.length === 1 ? " row applied" : " rows applied"));
    clearImport();
    setSubtitle();
    showScreen(kind === "stores" ? "stores" : "targets");
  }

  /* ═══════════════════ export ═══════════════════
   *
   * The CSVs are shaped for Power BI: one flat table each, a stable
   * storeId to join on, conversion as a decimal fraction and the month as
   * a real first-of-month date so it folds onto a date table without
   * being parsed out of a string.
   */

  function toCsv(header, rows) {
    var lines = [header.map(escapeCsv).join(",")];
    rows.forEach(function (row) { lines.push(row.map(escapeCsv).join(",")); });
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  function storesCsv() {
    var header = ["storeId", "storeName", "storeManager", "storeBrand", "storeChannel", "country",
                  "status", "openDate", "closeDate", "salesArea",
                  "address", "latitude", "longitude"];
    var rows = Data.liveStores().map(function (s) {
      return header.map(function (k) { return s[k] === undefined ? "" : s[k]; });
    });
    return toCsv(header, rows);
  }

  function targetsCsv() {
    var header = ["storeId", "storeName", "month", "monthStart",
                  "salesTarget", "trafficTarget", "conversionTarget", "uptTarget", "aspTarget", "sotTarget",
                  "impliedSales", "salesVariancePct"];
    var byId = {};
    Data.liveStores().forEach(function (s) { byId[s.storeId] = s; });

    var rows = Data.liveTargets()
      .sort(function (a, b) {
        return a.month === b.month
          ? String(a.storeId).localeCompare(String(b.storeId), undefined, { numeric: true })
          : a.month.localeCompare(b.month);
      })
      .map(function (t) {
        var store = byId[t.storeId];
        var implied = impliedSales(t);
        var variance = implied !== null && isNum(t.sales) && t.sales !== 0
          ? round((implied - t.sales) / Math.abs(t.sales) * 100, 4) : "";
        return [
          t.storeId,
          store ? store.storeName : "",
          t.month,
          t.month + "-01",
          blank(t.sales), blank(t.traffic), blank(t.conversion),
          blank(t.upt), blank(t.asp), blank(t.sot),
          implied === null ? "" : round(implied, 2),
          variance
        ];
      });
    return toCsv(header, rows);
  }

  function blank(v) { return v === undefined || v === null ? "" : v; }

  function stamp() { return new Date().toISOString().slice(0, 10); }

  /* ── templates ── */

  function templateStores() {
    var header = ["storeId", "storeName", "storeManager", "storeBrand", "storeChannel", "country",
                   "status", "openDate", "salesArea", "address", "latitude", "longitude"];
    return toCsv(header, [
      ["S001", "Oxford Street", "A. Kowalski", "Nike", "Retail", "United Kingdom", "active", "2019-03-14", "420"],
      ["S002", "Bicester Village", "R. Mensah", "Multi", "Outlet", "United Kingdom", "active", "2021-09-02", "260"],
      ["S003", "Selfridges Concession", "L. Ferrari", "Under Armour", "Concession", "United Kingdom", "active", "2023-02-20", "85"]
    ]);
  }

  function templateTargetsLong() {
    var next = shiftMonth(thisMonth(), 1);
    var header = ["storeId", "month", "salesTarget", "trafficTarget", "conversionTarget", "uptTarget", "aspTarget", "sotTarget"];
    return toCsv(header, [
      ["S001", next, "182000", "26000", "0.14", "1.85", "27.05", "7.00"],
      ["S002", next, "96000", "19000", "0.16", "2.10", "15.04", "5.05"],
      ["S003", shiftMonth(next, 1), "44000", "9000", "0.11", "1.60", "27.78", "4.89"]
    ]);
  }

  function templateTargetsWide() {
    var start = shiftMonth(thisMonth(), 1);
    var months = [0, 1, 2, 3, 4, 5].map(function (i) { return shiftMonth(start, i); });
    var header = ["storeId", "metric"].concat(months);
    var rows = [];
    Data.liveStores().slice(0, 3).forEach(function (s) {
      rows.push([s.storeId, "Sales"].concat(months.map(function () { return ""; })));
      rows.push([s.storeId, "Traffic"].concat(months.map(function () { return ""; })));
    });
    if (!rows.length) {
      rows.push(["S001", "Sales", "182000", "150000", "141000", "160000", "175000", "210000"]);
      rows.push(["S001", "Traffic", "26000", "23000", "22000", "24000", "25000", "29000"]);
      rows.push(["S002", "Sales", "96000", "88000", "84000", "90000", "94000", "112000"]);
    }
    return toCsv(header, rows);
  }

  /* ═══════════════════ settings ═══════════════════ */

  function renderSettings() {
    var settings = Data.settings();
    $("set-currency").value = settings.currency;
    $("app-version").textContent = "RetailOS v" + VERSION +
      (Remote.signedIn() ? " · syncing with Supabase" : " · data on this device only");
    renderSyncSection();

    $("backup-note").textContent = Remote.signedIn()
      ? "The server holds a copy too, so losing this browser is no longer the end of it. A file backup is still the only thing that survives a mistake on the server."
      : "There is one copy of this data and it lives in this browser. Keep a backup. Safari deletes storage for sites left unopened for a week or so.";

    var bytes = 0;
    [K.stores, K.targets, K.settings].forEach(function (key) {
      var raw = localStorage.getItem(key);
      if (raw) bytes += raw.length;
    });
    var stores = Data.liveStores().length;
    var targets = Data.liveTargets().length;
    $("storage-info").textContent =
      stores + " stores and " + targets + " store-months, about " + Math.max(1, Math.round(bytes / 1024)) + " KB. "
      + "Browsers allow a few megabytes, so there is a long way to go before size is the problem — "
      + "losing the browser is.";
  }

  /* ── sync ── */

  // Called by Sync at each step, and by the screens when they render, so
  // there is one description of the state rather than one per caller.
  function onSyncStateChanged(result) {
    if (typeof document === "undefined") return;
    setSubtitle();
    if ($("sync-status")) renderSyncSection();
    if (result && (result.pulled || result.pushed)) {
      // A pull that changed something is on screen already only if the user
      // is looking at it, so redraw whichever screen that is.
      renderStores();
      renderTargets();
      toast(syncSummary(result));
    }
  }

  function syncSummary(result) {
    if (!result.pulled && !result.pushed) return "Already up to date";
    var parts = [];
    if (result.pulled) parts.push(result.pulled + " in");
    if (result.pushed) parts.push(result.pushed + " out");
    return "Synced · " + parts.join(", ");
  }

  function renderSyncSection() {
    var inBox = $("sync-in");
    var outBox = $("sync-out");
    if (!inBox || !outBox) return;
    var signedIn = Remote.signedIn();
    inBox.hidden = !signedIn;
    outBox.hidden = signedIn;

    if (!Remote.configured()) {
      outBox.hidden = false;
      inBox.hidden = true;
      $("sync-form").hidden = true;
      showError("sync-error", "No Supabase project is configured, so there is nothing to sign in to.");
      return;
    }
    $("sync-form").hidden = false;

    if (!signedIn) return;

    var status = "Signed in as " + Remote.email() + ". ";
    if (Sync.inFlight) status += "Syncing…";
    else if (Sync.lastError) status += "Last attempt failed.";
    else if (Sync.lastSyncedAt) status += "Last synced at " + new Date(Sync.lastSyncedAt).toLocaleTimeString() + ".";
    else status += "Not synced yet.";

    // The app showing months the database has never seen is exactly the
    // confusion this line exists to prevent.
    var behind = [];
    if (Sync.behind.stores) behind.push(Sync.behind.stores + (Sync.behind.stores === 1 ? " store" : " stores"));
    if (Sync.behind.targets) behind.push(Sync.behind.targets + " store-month" + (Sync.behind.targets === 1 ? "" : "s"));
    if (behind.length) status += " " + behind.join(" and ") + " on this device have not reached the server.";

    $("sync-status").textContent = status;
    showError("sync-error-in", Sync.lastError);
    $("btn-sync-now").disabled = !!Sync.inFlight;
  }

  function showError(id, message) {
    var node = $(id);
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  }

  function signInFromForm(event) {
    event.preventDefault();
    var button = $("btn-sign-in");
    showError("sync-error", "");
    button.disabled = true;
    button.textContent = "Signing in…";

    Remote.signIn($("sync-email").value.trim(), $("sync-password").value)
      .then(function () {
        $("sync-password").value = "";
        renderSettings();
        setSubtitle();
        return Sync.now();
      })
      .catch(function (e) {
        showError("sync-error", e && e.message ? e.message : "Could not sign in.");
      })
      .then(function () {
        button.disabled = false;
        button.textContent = "Sign in";
        renderSettings();
      });
  }

  function signOutAndForget() {
    if (!confirm("Sign out on this device? The data stays in this browser and on the server.")) return;
    Remote.signOut().then(function () {
      Sync.lastSyncedAt = "";
      Sync.lastError = "";
      renderSettings();
      setSubtitle();
      toast("Signed out");
    });
  }

  function syncNow() {
    Sync.now().then(function (result) {
      if (result && !result.pulled && !result.pushed) toast("Already up to date");
    }, function () { renderSyncSection(); });
  }

  function restoreFromFile(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var doc;
      try { doc = JSON.parse(text); } catch (e) { toast("That is not a JSON file."); return; }
      try {
        var result = Data.mergeDocument(doc);
        toast("Merged " + result.stores + " stores and " + result.targets + " target rows");
        renderSettings();
        setSubtitle();
      } catch (e) {
        toast(e.message || "Could not merge that backup.");
      }
      $("restore-file").value = "";
    });
  }

  function resetEverything() {
    if (!confirm("Delete every store and every target on this device? A backup you have exported is the only way back.")) return;
    if (!confirm("Really delete everything?")) return;
    [K.stores, K.targets, K.settings, K.mapping].forEach(function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* nothing useful to do */ }
    });
    toast("Deleted");
    setSubtitle();
    showScreen("stores");
  }

  /* ═══════════════════ start ═══════════════════ */

  function wire() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () { showScreen(tab.dataset.screen); });
    });

    /* stores */
    $("store-search").addEventListener("input", renderStores);
    $("btn-add-store").addEventListener("click", function () { openStore(null); });
    $("store-form").addEventListener("submit", saveStoreFromForm);
    $("btn-cancel-store").addEventListener("click", function () { $("store-dialog").close(); });
    $("btn-delete-store").addEventListener("click", deleteCurrentStore);

    [["f-storeChannel", CHANNELS], ["f-storeBrand", BRANDS]].forEach(function (pair) {
      var select = $(pair[0]);
      var none = el("option", null, "—");
      none.value = "";
      select.appendChild(none);
      pair[1].forEach(function (name) {
        var option = el("option", null, name);
        option.value = name;
        select.appendChild(option);
      });
    });

    /* targets */
    ["target-view", "target-month", "target-store", "chk-variance"].forEach(function (id) {
      $(id).addEventListener("change", renderTargets);
    });
    $("btn-fill-down").addEventListener("click", fillDown);

    /* import */
    var metricSelect = $("import-metric");
    METRICS.forEach(function (m) {
      var option = el("option", null, m.label);
      option.value = m.key;
      metricSelect.appendChild(option);
    });
    $("import-file").addEventListener("change", onImportFile);
    $("btn-parse").addEventListener("click", function () {
      if ($("import-paste").value.trim()) { importState.sheets = null; importState.rows = null; }
      runPreview();
    });
    $("btn-clear-import").addEventListener("click", clearImport);
    ["import-kind", "import-metric", "import-year"].forEach(function (id) {
      $(id).addEventListener("change", function () { if (importState.rows) runPreview(); });
    });
    $("import-paste").addEventListener("paste", function () {
      setTimeout(function () { importState.sheets = null; importState.rows = null; runPreview(); }, 0);
    });
    $("btn-tpl-stores").addEventListener("click", function () { download("retailos-stores-template.csv", templateStores(), "text/csv"); });
    $("btn-tpl-targets-long").addEventListener("click", function () { download("retailos-targets-template.csv", templateTargetsLong(), "text/csv"); });
    $("btn-tpl-targets-wide").addEventListener("click", function () { download("retailos-targets-wide-template.csv", templateTargetsWide(), "text/csv"); });

    /* settings */
    $("set-currency").addEventListener("change", function () {
      var value = $("set-currency").value.trim().toUpperCase().slice(0, 3);
      $("set-currency").value = value;
      Data.saveSettings({ currency: value || "GBP" });
      renderTargets();
    });
    $("btn-export-json").addEventListener("click", function () {
      download("retailos-backup-" + stamp() + ".json", JSON.stringify(Data.exportDocument(), null, 2), "application/json");
    });
    $("btn-export-stores").addEventListener("click", function () { download("retailos-stores-" + stamp() + ".csv", storesCsv(), "text/csv"); });
    $("btn-export-targets").addEventListener("click", function () { download("retailos-targets-" + stamp() + ".csv", targetsCsv(), "text/csv"); });
    $("sync-form").addEventListener("submit", signInFromForm);
    $("btn-sync-now").addEventListener("click", syncNow);
    $("btn-sign-out").addEventListener("click", signOutAndForget);
    $("restore-file").addEventListener("change", restoreFromFile);
    $("btn-reset").addEventListener("click", resetEverything);
  }

  function start() {
    wire();
    // Targets are set at the end of a month for the month ahead, so that is
    // the one to open on rather than the month already being traded.
    var next = shiftMonth(thisMonth(), 1);
    fillSelect($("target-month"), monthOptions(), monthLabel, false);
    $("target-month").value = next;
    $("import-year").value = String(new Date().getFullYear());
    showScreen("stores");
    // Opening the app on a second device should show that device's changes
    // without anyone having to ask for them.
    if (Remote.signedIn()) Sync.now().catch(function () { /* shown in Settings */ });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }

  // Reached only by the test scripts, which import this file into Node.
  // A browser has no `module`, so it never takes this branch.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      VERSION: VERSION, METRICS: METRICS, CHANNELS: CHANNELS,
      toNumber: toNumber, parseMonth: parseMonth, monthLabel: monthLabel, shiftMonth: shiftMonth,
      parseDelimited: parseDelimited, sniffDelimiter: sniffDelimiter,
      detectLayout: detectLayout, buildStoreRows: buildStoreRows, buildTargetRows: buildTargetRows,
      readMetric: readMetric, matchChannel: matchChannel, normaliseStatus: normaliseStatus,
      cleanDate: cleanDate, impliedSales: impliedSales, impliedSot: impliedSot, checksFor: checksFor,
      readWorkbook: readWorkbook, mergeById: mergeById, storeIndex: storeIndex,
      settleConversion: settleConversion, isBlank: isBlank,
      storeToRemote: storeToRemote, storeFromRemote: storeFromRemote,
      targetToRemote: targetToRemote, targetFromRemote: targetFromRemote,
      newerHere: newerHere, authMessage: authMessage, restMessage: restMessage,
      BRANDS: BRANDS, matchBrand: matchBrand,
      cleanCoordinate: cleanCoordinate
    };
  }

})();
