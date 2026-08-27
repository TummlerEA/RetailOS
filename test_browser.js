/*
 * Drives the real app in a real browser: the .xlsx reader, the import
 * preview, the targets grid and the fact that anything saved is still
 * there after a reload.
 *
 *   node test_browser.js
 *
 * Needs Playwright and a Chromium. The pure logic is covered without a
 * browser by test_logic.js, which is the one to run first when something
 * breaks — this file only adds what needs a DOM.
 */
var path = require("path");
var Module = require("module");

// Playwright is usually installed globally rather than in this repo, which
// has no package.json and wants none.
["/opt/node22/lib/node_modules", "/usr/lib/node_modules", "/usr/local/lib/node_modules"]
  .forEach(function (dir) { if (Module.globalPaths.indexOf(dir) < 0) Module.globalPaths.push(dir); });

var chromium;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  try {
    chromium = require("/opt/node22/lib/node_modules/playwright").chromium;
  } catch (e2) {
    console.log("Playwright is not installed — skipping the browser tests.");
    console.log("  npm install -g playwright   (a Chromium must also be present)");
    process.exit(0);
  }
}

var APP = "file://" + path.join(__dirname, "index.html");
var FIXTURES = path.join(__dirname, "test", "fixtures");

var failures = 0;
var checks = 0;

function ok(name, condition, detail) {
  checks++;
  if (condition) { console.log("  ok    " + name); return; }
  failures++;
  console.log("  FAIL  " + name + (detail ? "\n        " + detail : ""));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function near(name, actual, expected) {
  ok(name, actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-6,
     "expected ~" + expected + ", got " + actual);
}

function tally(page, kind) {
  return page.locator("#import-report .pill." + kind).first().textContent()
    .then(function (text) { return parseInt(text, 10); });
}

function stored(page, key) {
  return page.evaluate(function (k) { return JSON.parse(localStorage.getItem(k) || "null"); }, key);
}

/* A Supabase stand-in, installed into the page before any of its own
 * scripts run. It keeps its state in localStorage so it survives a reload,
 * and records every push so the tests can check what was sent. */
function fakeServer() {
  var KEY = "__fake_server";
  var PASSWORD = "correct-horse";

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { stores: [], targets: [], pushes: [] }; }
    catch (e) { return { stores: [], targets: [], pushes: [] }; }
  }
  function write(db) { localStorage.setItem(KEY, JSON.stringify(db)); }

  function reply(status, body) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      text: function () { return Promise.resolve(body === null ? "" : JSON.stringify(body)); }
    });
  }

  window.fetch = function (url, options) {
    url = String(url);
    options = options || {};
    var db = read();

    if (url.indexOf("/auth/v1/token") >= 0) {
      var sent = JSON.parse(options.body || "{}");
      if (sent.password !== undefined && sent.password !== PASSWORD) return reply(400, { error: "invalid_grant" });
      return reply(200, {
        access_token: "test-token", refresh_token: "test-refresh", expires_in: 3600,
        user: { email: sent.email || "hq@example.com" }
      });
    }
    if (url.indexOf("/auth/v1/logout") >= 0) return reply(204, null);

    var table = url.indexOf("/rest/v1/targets") >= 0 ? "targets" : "stores";
    if ((options.method || "GET") === "GET") return reply(200, db[table]);

    var rows = JSON.parse(options.body || "[]");
    // db.slow holds the first write open. A change made in that window has
    // missed this round's push selection entirely, which is the case being
    // tested: it is owed a round of its own.
    var hold = 0;
    if (db.slow) { db.slow = false; hold = 900; }
    var idOf = table === "stores"
      ? function (r) { return r.store_id; }
      : function (r) { return r.store_id + "|" + r.month; };
    db.pushes.push({ table: table, rows: rows });
    rows.forEach(function (row) {
      var at = -1;
      db[table].forEach(function (existing, n) { if (idOf(existing) === idOf(row)) at = n; });
      if (at >= 0) db[table][at] = row; else db[table].push(row);
    });
    write(db);
    if (!hold) return reply(201, null);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(reply(201, null)); }, hold);
    });
  };
}

function run() {
  var browser, page;

  return chromium.launch({ headless: true })
    .then(function (b) {
      browser = b;
      return b.newPage();
    })
    .then(function (p) {
      page = p;
      page.on("pageerror", function (error) {
        failures++;
        console.log("  FAIL  uncaught page error: " + error.message);
      });
      return page.goto(APP);
    })

    /* ── the app comes up empty ── */
    .then(function () {
      console.log("first run");
      return page.locator("#store-list .empty").textContent();
    })
    .then(function (text) {
      ok("starts with an empty store list", /No stores yet/.test(text));
      return page.locator("#topbar-sub").textContent();
    })
    .then(function (text) {
      ok("and says so in the header", /No stores yet/.test(text));
    })

    /* ── targets before stores ── */
    .then(function () {
      return page.click("#tab-targets");
    })
    .then(function () { return page.locator("#target-empty").isVisible(); })
    .then(function (visible) {
      ok("the targets grid asks for stores first", visible);
    })

    /* ── importing a store list from a real .xlsx ── */
    .then(function () {
      console.log("stores.xlsx");
      return page.click("#tab-import");
    })
    .then(function () {
      return page.setInputFiles("#import-file", path.join(FIXTURES, "stores.xlsx"));
    })
    .then(function () { return page.waitForSelector("#import-report .pill"); })
    .then(function () { return page.locator("#import-report .muted").first().textContent(); })
    .then(function (text) {
      ok("read as a store list", /store list/.test(text), text);
      return tally(page, "add");
    })
    .then(function (adds) {
      eq("five stores are new", adds, 5);
      return tally(page, "chg");
    })
    .then(function (changes) {
      eq("nothing is a change yet", changes, 0);
      return page.locator("#import-report .pill.bad").count();
    })
    .then(function (count) {
      eq("nothing is rejected", count, 0);
      return page.click("#import-report .btn-primary");
    })
    .then(function () { return page.waitForSelector("#screen-stores.is-active"); })
    .then(function () { return page.locator("#store-list .card").count(); })
    .then(function (count) {
      eq("five store cards appear", count, 5);
      return stored(page, "retailos-stores");
    })
    .then(function (stores) {
      var byId = {};
      stores.forEach(function (s) { byId[s.storeId] = s; });
      eq("a date typed as dd/mm/yyyy is read", byId.S001.openDate, "2019-03-14");
      eq("'Trading' becomes active", byId.S001.status, "active");
      eq("'SIS' becomes Concession", byId.S003.storeChannel, "Concession");
      eq("'Online' becomes Ecommerce", byId.S005.storeChannel, "Ecommerce");
      eq("the sales area is a number", byId.S001.salesArea, 420);
      ok("every store is stamped", stores.every(function (s) { return !!s.updatedAt; }));
    })

    /* ── importing the same file again changes nothing ── */
    .then(function () {
      console.log("the same file twice");
      return page.click("#tab-import");
    })
    .then(function () { return page.click("#btn-clear-import"); })
    .then(function () {
      return page.setInputFiles("#import-file", path.join(FIXTURES, "stores.xlsx"));
    })
    .then(function () { return page.waitForSelector("#import-report .pill"); })
    .then(function () { return tally(page, "add"); })
    .then(function (adds) {
      eq("no new stores the second time", adds, 0);
      return tally(page, "chg");
    })
    .then(function (changes) {
      eq("and no changes either", changes, 0);
      return page.locator("#import-report .btn-primary").isDisabled();
    })
    .then(function (disabled) {
      ok("so there is nothing to apply", disabled);
      return page.locator("#import-report .muted").last().textContent();
    })
    .then(function (text) {
      ok("and the app says as much", /already been imported/.test(text), text);
    })

    /* ── targets, one row per store-month ── */
    .then(function () {
      console.log("targets-long.xlsx");
      return page.click("#btn-clear-import");
    })
    .then(function () {
      return page.setInputFiles("#import-file", path.join(FIXTURES, "targets-long.xlsx"));
    })
    .then(function () { return page.waitForSelector("#import-report .pill"); })
    .then(function () { return tally(page, "add"); })
    .then(function (adds) {
      // S404 is refused outright; S004 keeps its four readable targets and
      // loses only the sales cell someone typed "tbc" into.
      eq("four store-months are new", adds, 4);
      return tally(page, "bad");
    })
    .then(function (bad) {
      eq("two values are left out", bad, 2);
      return page.locator("#import-report .why").allTextContents();
    })
    .then(function (reasons) {
      ok("the unknown store is named", reasons.some(function (r) { return /S404 is not in the store list/.test(r); }),
         JSON.stringify(reasons));
      ok("so is the cell with a word in it", reasons.some(function (r) { return /"tbc" is not a number/.test(r); }),
         JSON.stringify(reasons));
      return page.locator("#import-report .muted").allTextContents();
    })
    .then(function (notes) {
      ok("conversion in percentage points is called out",
         notes.some(function (n) { return /read as percentage points/.test(n); }), JSON.stringify(notes));
      return page.click("#import-report .btn-primary");
    })
    .then(function () { return page.waitForSelector("#screen-targets.is-active"); })
    .then(function () { return stored(page, "retailos-targets"); })
    .then(function (targets) {
      var s001 = targets.filter(function (t) { return t.id === "S001|2026-03"; })[0];
      ok("March 2026 was read from 'Mar-26'", !!s001, JSON.stringify(targets.map(function (t) { return t.id; })));
      near("sales stored as typed", s001.sales, 182000);
      near("conversion stored as a fraction", s001.conversion, 0.14);
      near("sot stored as typed", s001.sot, 7);
    })

    /* ── the grid ── */
    .then(function () {
      console.log("the targets grid");
      return page.selectOption("#target-month", "2026-03");
    })
    .then(function () { return page.locator("#target-grid tbody tr").count(); })
    .then(function (rows) {
      eq("a row per open store", rows, 5);
      return page.locator('#target-grid input[data-store-id="S001"][data-metric="conversion"]').inputValue();
    })
    .then(function (value) {
      eq("conversion is shown as percentage points", parseFloat(value), 14);
      return page.locator("#target-grid tbody tr").first().locator("td.var").textContent();
    })
    .then(function (text) {
      eq("a consistent row passes the check", text.trim(), "✓");
    })

    /* ── the check catches a bad edit ── */
    .then(function () {
      var cell = page.locator('#target-grid input[data-store-id="S001"][data-metric="sales"]');
      return cell.fill("250000").then(function () { return cell.blur(); });
    })
    .then(function () { return page.waitForTimeout(120); })
    .then(function () {
      return page.locator('#target-grid tbody tr:has(td.k:has-text("Oxford Street")) td.var').textContent();
    })
    .then(function (text) {
      ok("an impossible sales figure is flagged", /Sales/.test(text) && /%/.test(text), text);
      var cell = page.locator('#target-grid input[data-store-id="S001"][data-metric="sales"]');
      return cell.fill("182000").then(function () { return cell.blur(); });
    })
    .then(function () { return page.waitForTimeout(120); })

    /* ── conversion is refused outside 0-100% ── */
    .then(function () {
      var cell = page.locator('#target-grid input[data-store-id="S002"][data-metric="conversion"]');
      return cell.fill("140").then(function () { return cell.blur(); });
    })
    .then(function () { return page.waitForTimeout(120); })
    .then(function () { return stored(page, "retailos-targets"); })
    .then(function (targets) {
      var s002 = targets.filter(function (t) { return t.id === "S002|2026-03"; })[0];
      near("a conversion of 140% is refused", s002.conversion, 0.16);
    })

    /* ── months across the top, as real dates, on the second sheet ── */
    .then(function () {
      console.log("targets-wide.xlsx");
      return page.click("#tab-import");
    })
    .then(function () { return page.click("#btn-clear-import"); })
    .then(function () {
      return page.setInputFiles("#import-file", path.join(FIXTURES, "targets-wide.xlsx"));
    })
    .then(function () { return page.waitForSelector("#import-report .pill"); })
    .then(function () { return page.locator("#import-sheet").count(); })
    .then(function (count) {
      eq("a sheet picker appears for a multi-sheet workbook", count, 1);
      return page.locator("#import-sheet").inputValue();
    })
    .then(function (value) {
      eq("and it lands on the sheet with the data, not the cover", value, "1");
      return page.locator("#import-report .muted").first().textContent();
    })
    .then(function (text) {
      ok("read as months across the top", /months across the top/.test(text), text);
      ok("all six months found", /6 months/.test(text), text);
      return tally(page, "add");
    })
    .then(function (adds) {
      // 3 stores x 6 months = 18, less the 3 already carrying March targets.
      eq("fifteen new store-months", adds, 15);
      return tally(page, "chg");
    })
    .then(function (changes) {
      eq("March for S001 has been re-cut", changes, 1);
      return page.click("#import-report .btn-primary");
    })
    .then(function () { return page.waitForSelector("#screen-targets.is-active"); })
    .then(function () { return stored(page, "retailos-targets"); })
    .then(function (targets) {
      var jan = targets.filter(function (t) { return t.id === "S001|2026-01"; })[0];
      ok("January came out of a formatted date header", !!jan);
      near("its sales", jan.sales, 150000);
      near("its traffic", jan.traffic, 23000);
      var march = targets.filter(function (t) { return t.id === "S001|2026-03"; })[0];
      near("March kept the conversion the other file set", march.conversion, 0.14);
      near("while taking the re-cut sales from this one", march.sales, 185000);
    })

    /* ── pasting straight out of Excel ── */
    .then(function () {
      console.log("paste from Excel");
      return page.click("#tab-import");
    })
    .then(function () { return page.click("#btn-clear-import"); })
    .then(function () {
      return page.fill("#import-paste",
        "Store ID\tMonth\tSales Target\tTraffic Target\nS004\t2026-04\t120000\t15000\n");
    })
    .then(function () { return page.click("#btn-parse"); })
    .then(function () { return page.waitForSelector("#import-report .pill"); })
    .then(function () { return tally(page, "add"); })
    .then(function (adds) {
      eq("a pasted block is read like a file", adds, 1);
      return page.click("#import-report .btn-primary");
    })
    .then(function () { return stored(page, "retailos-targets"); })
    .then(function (targets) {
      var s004 = targets.filter(function (t) { return t.id === "S004|2026-04"; })[0];
      near("and lands in the same place", s004.sales, 120000);
    })

    /* ── editing a store by hand ── */
    .then(function () {
      console.log("editing");
      return page.click("#tab-stores");
    })
    .then(function () { return page.click("#store-list .card >> nth=0"); })
    .then(function () { return page.locator("#f-storeId").isEditable(); })
    .then(function (editable) {
      ok("the ID of an existing store cannot be retyped", !editable);
      return page.fill("#f-storeManager", "J. Okonkwo");
    })
    .then(function () { return page.click('#store-form button[type="submit"]'); })
    .then(function () { return page.waitForTimeout(100); })
    .then(function () { return stored(page, "retailos-stores"); })
    .then(function (stores) {
      eq("the edit is saved", stores.filter(function (s) { return s.storeId === "S001"; })[0].storeManager, "J. Okonkwo");
    })

    /* ── a real file, pasted in ── */
    .then(function () {
      console.log("a real paste");
      return page.click('.tab[data-screen="import"]');
    })
    .then(function () { return page.selectOption("#import-kind", "stores"); })
    .then(function () {
      return page.fill("#import-paste", [
        "store_id\tstore_name\tbrand\tchannel",
        "0Ц-000018\tJNS МОС Авиапарк\tMulti\tRetail",
        "0Ц-000019\tJNS МОС Атриум\tMulti\tRetail"
      ].join("\n"));
    })
    .then(function () { return page.click("#btn-parse"); })
    .then(function () { return page.waitForTimeout(200); })
    .then(function () { return page.click("#import-report .btn-primary"); })
    .then(function () { return page.waitForTimeout(200); })
    .then(function () { return stored(page, "retailos-stores"); })
    .then(function (stores) {
      var cyr = stores.filter(function (s) { return s.storeId === "0Ц-000018"; })[0];
      ok("a Cyrillic store ID survives the round trip", !!cyr, JSON.stringify(stores.map(function (s) { return s.storeId; })));
      eq("with its name", cyr.storeName, "JNS МОС Авиапарк");
    })

    // Applying moves to the screen the rows landed on, so come back.
    .then(function () { return page.click('.tab[data-screen="import"]'); })
    .then(function () { return page.selectOption("#import-kind", "targets"); })
    .then(function () {
      return page.fill("#import-paste", [
        "month\tstore_id\tstore_name\tsales\ttrafic\tconversion\tupt\tasp\tsot",
        "01.08.2026\t0Ц-000018\tJNS МОС Авиапарк\t15112500\t10000\t0.075\t1.55\t13000\t 1,511 ",
        "01.08.2026\t0Ц-000019\tJNS МОС Атриум\t9741600\t4500\t0.11\t1.6\t12300\t 2,165 "
      ].join("\n"));
    })
    .then(function () { return page.click("#btn-parse"); })
    .then(function () { return page.waitForTimeout(200); })
    .then(function () { return tally(page, "add"); })
    .then(function (count) { eq("both store-months are new", count, 2); })
    .then(function () { return page.locator("#import-report").textContent(); })
    .then(function (text) {
      ok("and nothing was left out", !/left out/.test(text) || /0 left out/.test(text), text.slice(0, 200));
      return page.click("#import-report .btn-primary");
    })
    .then(function () { return page.waitForTimeout(200); })
    .then(function () { return stored(page, "retailos-targets"); })
    .then(function (targets) {
      var august = targets.filter(function (t) { return t.storeId === "0Ц-000018" && t.month === "2026-08"; })[0];
      ok("the dotted date landed in August 2026", !!august, JSON.stringify(targets.map(function (t) { return t.month; })));
      near("sales", august.sales, 15112500);
      near("traffic came in despite the typo in the header", august.traffic, 10000);
      near("conversion is left as the fraction it was", august.conversion, 0.075);
      near("SOT read past its spaces and comma", august.sot, 1511);
    })

    /* ── brand, kept apart from channel ── */
    .then(function () {
      console.log("brand");
      return page.click('.tab[data-screen="stores"]')
        .then(function () { return page.click('#store-list .card:has-text("S002")'); });
    })
    .then(function () { return page.locator("#f-storeBrand option").allTextContents(); })
    .then(function (options) {
      eq("the brand list is the five, plus a blank", options.join("|"), "—|Multi|Asics|Under Armour|Levis|Nike");
      return page.selectOption("#f-storeBrand", "Under Armour");
    })
    .then(function () { return page.locator("#f-storeChannel").inputValue(); })
    .then(function (channel) {
      ok("choosing a brand leaves the channel alone", channel !== "Under Armour", channel);
      return page.click('#store-form button[type="submit"]');
    })
    .then(function () { return page.waitForTimeout(100); })
    .then(function () { return stored(page, "retailos-stores"); })
    .then(function (stores) {
      var s2 = stores.filter(function (s) { return s.storeId === "S002"; })[0];
      eq("the brand is saved", s2.storeBrand, "Under Armour");
      ok("and the channel survived it", !!s2.storeChannel && s2.storeChannel !== "Under Armour", s2.storeChannel);
    })
    // The search box normalises through the same function the headers use,
    // so this is the other half of the Cyrillic fix: before it, a Russian
    // query reduced to an empty string and matched every store.
    .then(function () { return page.fill("#store-search", "Авиапарк"); })
    .then(function () { return page.locator("#store-list .card").count(); })
    .then(function (count) {
      eq("searching by a Russian store name filters rather than matching all", count, 1);
      return page.fill("#store-search", "");
    })
    .then(function () { return page.fill("#store-search", "Under Armour"); })
    .then(function () { return page.locator("#store-list .card").count(); })
    .then(function (count) {
      eq("searching by brand finds it", count, 1);
      return page.fill("#store-search", "");
    })

    /* ── address and coordinates ── */
    .then(function () {
      console.log("location");
      return page.click('#store-list .card:has-text("S003")');
    })
    .then(function () { return page.fill("#f-address", "12 Tverskaya St"); })
    .then(function () { return page.fill("#f-latitude", "55.7446675"); })
    .then(function () { return page.fill("#f-longitude", "37.5658937"); })
    .then(function () { return page.click('#store-form button[type="submit"]'); })
    .then(function () { return page.waitForTimeout(100); })
    .then(function () { return stored(page, "retailos-stores"); })
    .then(function (stores) {
      var s3 = stores.filter(function (s) { return s.storeId === "S003"; })[0];
      eq("the address is saved", s3.address, "12 Tverskaya St");
      eq("latitude keeps every digit typed", s3.latitude, "55.7446675");
      eq("longitude too", s3.longitude, "37.5658937");
    })
    .then(function () { return page.click('#store-list .card:has-text("S003")'); })
    .then(function () { return page.locator("#f-latitude").inputValue(); })
    .then(function (value) {
      eq("and comes back into the form unchanged", value, "55.7446675");
      return page.click("#btn-cancel-store");
    })

    /* ── the CSV meant for Power BI ── */
    .then(function () {
      console.log("export");
      return page.evaluate(function () {
        // Capture what the download would contain, without a download.
        return new Promise(function (resolve) {
          var realCreate = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            blob.text().then(resolve);
            URL.createObjectURL = realCreate;
            return "blob:captured";
          };
          document.getElementById("btn-export-targets").click();
        });
      });
    })
    .then(function (csv) {
      var lines = csv.replace(/^﻿/, "").trim().split("\r\n");
      var header = lines[0].split(",");
      eq("the first column is the join key", header[0], "storeId");
      ok("there is a real date to fold onto a calendar", header.indexOf("monthStart") >= 0, lines[0]);
      ok("the implied sales travel with it", header.indexOf("impliedSales") >= 0, lines[0]);
      var march = lines.filter(function (l) { return /^S001,.*2026-03,/.test(l); })[0];
      ok("a row per store-month", !!march, lines.slice(0, 3).join(" | "));
      ok("with the month as a first-of-month date", /2026-03-01/.test(march), march);
      ok("and conversion as a decimal, not a percentage", /,0\.14,/.test(march), march);
    })
    .then(function () {
      return page.evaluate(function () {
        return new Promise(function (resolve) {
          var realCreate = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            blob.text().then(resolve);
            URL.createObjectURL = realCreate;
            return "blob:captured";
          };
          document.getElementById("btn-export-stores").click();
        });
      });
    })
    .then(function (csv) {
      var lines = csv.replace(/^\ufeff/, "").trim().split("\r\n");
      var header = lines[0].split(",");
      ok("the stores CSV carries the address", header.indexOf("address") >= 0, lines[0]);
      ok("and brand as its own column", header.indexOf("storeBrand") >= 0, lines[0]);
      ok("alongside channel, not instead of it", header.indexOf("storeChannel") >= 0, lines[0]);
      ok("and the coordinates, for a map visual", header.indexOf("latitude") >= 0 && header.indexOf("longitude") >= 0, lines[0]);
      var row = lines.filter(function (l) { return /^S003,/.test(l); })[0];
      ok("with the coordinate unrounded", /55\.7446675/.test(row), row);
    })

    /* ── it is still there after a reload ── */
    .then(function () {
      console.log("reload");
      return page.reload();
    })
    .then(function () { return page.locator("#store-list .card").count(); })
    .then(function (count) {
      eq("the stores survive a reload", count, 7);
      return page.locator("#topbar-sub").textContent();
    })
    .then(function (text) {
      ok("and so do the targets", /store-months of targets/.test(text), text);
    })

    /* ── sync ──
     *
     * Supabase itself is not reachable from a test run, and pointing the
     * tests at the real project would mean writing to live data anyway.
     * So the server is stubbed at window.fetch, which is the exact seam the
     * app talks through: everything above it — the merge, what gets pushed,
     * the shape of each row, the error messages — is the real code.
     */
    .then(function () {
      console.log("sync");
      return page.addInitScript(fakeServer);
    })
    .then(function () { return page.reload(); })
    .then(function () {
      // The server already knows about a store this browser has never seen,
      // and holds a newer version of one it has.
      return page.evaluate(function () {
        localStorage.setItem("__fake_server", JSON.stringify({
          stores: [
            { store_id: "S900", store_name: "Leeds Trinity", store_channel: "Retail",
              status: "active", updated_at: "2030-01-01T00:00:00+00:00", deleted: false },
            { store_id: "S001", store_name: "Oxford Street", store_manager: "Server Wins",
              status: "active", updated_at: "2030-01-01T00:00:00+00:00", deleted: false }
          ],
          targets: [],
          pushes: []
        }));
      });
    })

    .then(function () { return page.click('.tab[data-screen="settings"]'); })
    .then(function () { return page.locator("#mode-badge").textContent(); })
    .then(function (text) { eq("before signing in the badge says where the data is", text.trim(), "On this device"); })

    .then(function () {
      return page.fill("#sync-email", "hq@example.com")
        .then(function () { return page.fill("#sync-password", "wrong"); })
        .then(function () { return page.click("#btn-sign-in"); })
        .then(function () { return page.waitForTimeout(200); })
        .then(function () { return page.locator("#sync-error").textContent(); });
    })
    .then(function (text) {
      ok("a wrong password is refused in plain words", /did not match/.test(text), text);
      return page.locator("#sync-in").isHidden();
    })
    .then(function (hidden) { ok("and nothing is signed in", hidden); })

    .then(function () {
      return page.fill("#sync-password", "correct-horse")
        .then(function () { return page.click("#btn-sign-in"); })
        .then(function () { return page.waitForTimeout(400); });
    })
    .then(function () { return page.locator("#sync-status").textContent(); })
    .then(function (text) {
      ok("signing in says who is signed in", /hq@example.com/.test(text), text);
      return page.locator("#mode-badge").textContent();
    })
    .then(function (text) { eq("and the badge changes", text.trim(), "Synced"); })

    /* what came down */
    .then(function () { return stored(page, "retailos-stores"); })
    .then(function (stores) {
      var byId = {};
      stores.forEach(function (s) { byId[s.storeId] = s; });
      ok("a store only the server had arrives", !!byId.S900 && byId.S900.storeName === "Leeds Trinity");
      eq("and a newer version of a store this device had wins", byId.S001.storeManager, "Server Wins");
      eq("nothing else is lost", stores.filter(function (s) { return !s.deleted; }).length, 8);
    })

    /* what went up */
    .then(function () {
      return page.evaluate(function () { return JSON.parse(localStorage.getItem("__fake_server")).pushes; });
    })
    .then(function (pushes) {
      var storeRows = [];
      var targetRows = [];
      pushes.forEach(function (p) { (p.table === "stores" ? storeRows : targetRows).push.apply(p.table === "stores" ? storeRows : targetRows, p.rows); });
      ok("the local stores are sent up", storeRows.length >= 4, storeRows.length + " rows");
      ok("stores go before targets", pushes.length > 1 && pushes[0].table === "stores", JSON.stringify(pushes.map(function (p) { return p.table; })));
      eq("the store the server was already right about is not sent back", storeRows.filter(function (r) { return r.store_id === "S900"; }).length, 0);

      var march = targetRows.filter(function (r) { return r.store_id === "S001" && r.month === "2026-03-01"; })[0];
      ok("a target month is sent as a first-of-month date", !!march, JSON.stringify(targetRows.slice(0, 2)));
      ok("conversion is sent as a fraction the check constraint accepts", march.conversion === null || (march.conversion >= 0 && march.conversion <= 1), String(march.conversion));
      ok("every column is sent, so clearing a target travels", "sot" in march);
      eq("and the row is not marked deleted", march.deleted, false);
    })

    /* a later edit goes up on its own */
    .then(function () {
      return page.evaluate(function () {
        var db = JSON.parse(localStorage.getItem("__fake_server"));
        db.pushes = [];
        localStorage.setItem("__fake_server", JSON.stringify(db));
      });
    })
    .then(function () { return page.click('.tab[data-screen="stores"]'); })
    // Not S001: the seed gave the server a 2030 timestamp for it, so the
    // pull correctly overwrites anything typed here. That is the rule
    // working, not a store to test an outbound edit on.
    .then(function () { return page.click('#store-list .card:has-text("S002")'); })
    .then(function () { return page.fill("#f-storeManager", "Edited After Signin"); })
    .then(function () { return page.click('#store-form button[type="submit"]'); })
    .then(function () { return page.waitForTimeout(2500); })
    .then(function () {
      return page.evaluate(function () { return JSON.parse(localStorage.getItem("__fake_server")); });
    })
    .then(function (db) {
      var sent = [];
      db.pushes.forEach(function (p) { if (p.table === "stores") sent.push.apply(sent, p.rows); });
      var edited = sent.filter(function (r) { return r.store_manager === "Edited After Signin"; });
      eq("an edit made while signed in reaches the server by itself", edited.length, 1);
      eq("and only the row that changed is sent", sent.length, 1);
    })

    /* a write that lands while a sync is running must not be lost */
    .then(function () {
      return page.evaluate(function () {
        var db = JSON.parse(localStorage.getItem("__fake_server"));
        db.pushes = [];
        db.slow = true;                 // hold the first write open
        localStorage.setItem("__fake_server", JSON.stringify(db));
      });
    })
    // First edit: gives the coming round something to push, so the hold on
    // that push actually engages.
    .then(function () { return page.click('.tab[data-screen="stores"]'); })
    .then(function () { return page.click('#store-list .card:has-text("S004")'); })
    .then(function () { return page.fill("#f-storeManager", "First Edit"); })
    .then(function () { return page.click('#store-form button[type="submit"]'); })
    // The round starts 1.5s after that write and then holds on its push.
    .then(function () { return page.waitForTimeout(1900); })
    // Second edit, landing inside that held push — after this round already
    // decided what to send. Dropping its sync is what lost whole imports.
    .then(function () { return page.click('#store-list .card:has-text("S005")'); })
    .then(function () { return page.fill("#f-storeManager", "Edited Mid Sync"); })
    .then(function () { return page.click('#store-form button[type="submit"]'); })
    .then(function () { return page.waitForTimeout(4000); })
    .then(function () {
      return page.evaluate(function () { return JSON.parse(localStorage.getItem("__fake_server")); });
    })
    .then(function (db) {
      var sent = [];
      db.pushes.forEach(function (p) { if (p.table === "stores") sent.push.apply(sent, p.rows); });
      eq("the edit before the sync reaches the server",
         sent.filter(function (r) { return r.store_manager === "First Edit"; }).length > 0, true);
      eq("and so does one made while that sync was still pushing",
         sent.filter(function (r) { return r.store_manager === "Edited Mid Sync"; }).length, 1);
    })

    /* signing out leaves the data alone */
    .then(function () {
      page.once("dialog", function (d) { d.accept(); });
      return page.click('.tab[data-screen="settings"]')
        .then(function () { return page.click("#btn-sign-out"); })
        .then(function () { return page.waitForTimeout(200); });
    })
    .then(function () { return page.locator("#sync-out").isVisible(); })
    .then(function (visible) { ok("signing out puts the form back", visible); })
    .then(function () { return page.locator("#store-list, #mode-badge").first().textContent(); })
    .then(function () { return page.locator("#mode-badge").textContent(); })
    .then(function (text) { eq("and the badge is honest about it again", text.trim(), "On this device"); })
    .then(function () { return stored(page, "retailos-stores"); })
    .then(function (stores) {
      eq("the data stays on the device", stores.filter(function (s) { return !s.deleted; }).length, 8);
    })

    .then(function () { return browser.close(); })
    .then(function () {
      console.log("");
      if (failures) {
        console.log(failures + " of " + checks + " checks failed.");
        process.exit(1);
      }
      console.log("All " + checks + " checks passed.");
    })
    .catch(function (error) {
      console.log("\nThe run stopped early: " + (error && error.stack || error));
      if (browser) browser.close();
      process.exit(1);
    });
}

run();
