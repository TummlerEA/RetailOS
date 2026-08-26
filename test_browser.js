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

    /* ── it is still there after a reload ── */
    .then(function () {
      console.log("reload");
      return page.reload();
    })
    .then(function () { return page.locator("#store-list .card").count(); })
    .then(function (count) {
      eq("the stores survive a reload", count, 5);
      return page.locator("#topbar-sub").textContent();
    })
    .then(function (text) {
      ok("and so do the targets", /store-months of targets/.test(text), text);
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
