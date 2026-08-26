/*
 * Tests for the parts of RetailOS that do not touch the DOM: reading numbers
 * and months out of whatever a spreadsheet holds, working out what a grid of
 * cells is, and the arithmetic between the six targets.
 *
 *   node test_logic.js
 *
 * The browser side — the .xlsx reader, the screens, the import preview — is
 * covered by test_browser.js, which drives the real app in a real browser.
 */
var app = require("./app.js");

var failures = 0;
var checks = 0;

function ok(name, condition, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.log("  FAIL  " + name + (detail ? "\n        " + detail : ""));
}

function eq(name, actual, expected) {
  ok(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function near(name, actual, expected) {
  ok(name, actual !== null && Math.abs(actual - expected) < 1e-9,
     "expected ~" + expected + ", got " + actual);
}

function group(name) { console.log(name); }

/* ── numbers as Excel hands them over ── */

group("numbers");
eq("plain", app.toNumber("1234"), 1234);
eq("thousands", app.toNumber("1,234,567"), 1234567);
eq("currency symbol", app.toNumber("£182,000"), 182000);
eq("trailing space", app.toNumber(" 96000 "), 96000);
eq("decimal", app.toNumber("27.05"), 27.05);
eq("continental", app.toNumber("1.234,56"), 1234.56);
eq("comma decimal", app.toNumber("27,05"), 27.05);
eq("accounting negative", app.toNumber("(1,200)"), -1200);
eq("percent text", app.toNumber("14%"), 0.14);
eq("already a number", app.toNumber(14000), 14000);
eq("blank", app.toNumber(""), null);
eq("dash placeholder", app.toNumber("—"), null);
eq("not a number", app.toNumber("n/a"), null);
eq("zero survives", app.toNumber("0"), 0);

/* ── months, in every shape a spreadsheet writes them ── */

group("months");
eq("iso", app.parseMonth("2026-03").key, "2026-03");
eq("iso slash", app.parseMonth("2026/3").key, "2026-03");
eq("full date", app.parseMonth("2026-03-01").key, "2026-03");
eq("compact", app.parseMonth("202603").key, "2026-03");
eq("uk order", app.parseMonth("03/2026").key, "2026-03");
eq("short name two digit year", app.parseMonth("Mar-26").key, "2026-03");
eq("short name spaced", app.parseMonth("Mar 2026").key, "2026-03");
eq("long name", app.parseMonth("March 2026").key, "2026-03");
eq("sept", app.parseMonth("Sept-26").key, "2026-09");
eq("year first with name", app.parseMonth("2026 March").key, "2026-03");
eq("real date object", app.parseMonth(new Date(Date.UTC(2026, 2, 1))).key, "2026-03");
eq("excel serial", app.parseMonth(46082).key, "2026-03");
eq("bare name needs a year", app.parseMonth("Mar").key, undefined);
eq("bare name with default year", app.parseMonth("Mar", 2026).key, "2026-03");
eq("month number needs a year", app.parseMonth(3).key, undefined);
eq("month number with default year", app.parseMonth(3, 2026).key, "2026-03");
eq("month 13 refused", app.parseMonth("2026-13").key, undefined);
eq("not a month", app.parseMonth("Sales").key, undefined);
eq("blank", app.parseMonth("").key, undefined);
eq("label", app.monthLabel("2026-03"), "Mar 2026");
eq("shift forward over a year end", app.shiftMonth("2026-11", 2), "2027-01");
eq("shift back", app.shiftMonth("2026-01", -1), "2025-12");

/* ── delimited text ── */

group("delimited text");
var tsv = app.parseDelimited("storeId\tstoreName\nS001\tOxford Street\n");
eq("tsv rows", tsv.length, 2);
eq("tsv cell", tsv[1][1], "Oxford Street");

var csv = app.parseDelimited('storeId,storeName\nS001,"Smith, Oxford St"\n');
eq("quoted comma", csv[1][1], "Smith, Oxford St");

var quoted = app.parseDelimited('a,b\n1,"he said ""hi"""\n');
eq("escaped quotes", quoted[1][1], 'he said "hi"');

eq("semicolons sniffed", app.sniffDelimiter("a;b;c\n1;2;3"), ";");
eq("tabs beat commas", app.sniffDelimiter("a\tb\n1,5\t2"), "\t");
eq("blank rows dropped", app.parseDelimited("a,b\n\n1,2\n").length, 2);

/* ── working out what a sheet is ── */

group("layout detection");

var storesSheet = [
  ["Store No", "Store Name", "Manager", "Channel", "Country"],
  ["S001", "Oxford Street", "A. Kowalski", "Retail", "UK"]
];
eq("a store list", app.detectLayout(storesSheet, null).kind, "stores");

var longSheet = [
  ["Store ID", "Month", "Sales Target", "Traffic Target", "Conversion Target", "UPT Target", "ASP Target", "SOT Target"],
  ["S001", "2026-03", "182000", "26000", "0.14", "1.85", "27.05", "7.00"]
];
var longLayout = app.detectLayout(longSheet, null);
eq("one row per store-month", longLayout.kind, "targets-long");
eq("found every metric column", Object.keys(longLayout.metricCols).length, 6);

var wideSheet = [
  ["Store", "Store Name", "Jan-26", "Feb-26", "Mar-26", "Apr-26"],
  ["S001", "Oxford Street", 150000, 141000, 182000, 160000]
];
var wideLayout = app.detectLayout(wideSheet, null);
eq("months across the top", wideLayout.kind, "targets-wide");
eq("four month columns", wideLayout.monthCols.length, 4);
eq("first is January", wideLayout.monthCols[0].month, "2026-01");

var stacked = [
  ["Store", "Metric", "2026-01", "2026-02"],
  ["S001", "Sales", 150000, 141000],
  ["S001", "Traffic", 23000, 22000]
];
var stackedLayout = app.detectLayout(stacked, null);
eq("wide with a metric column", stackedLayout.kind, "targets-wide");
ok("metric column found", stackedLayout.metricCol === 1);

var unknown = app.detectLayout([["Colour", "Size", "Notes"], ["red", "M", ""]], null);
eq("nothing recognisable", unknown.kind, "unknown");

var withJunk = app.detectLayout([["Store ID", "Month", "Sales", "Comments"], ["S001", "2026-01", 1, "x"]], null);
eq("unmatched columns are reported", withJunk.ignored.length, 1);
eq("and named", withJunk.ignored[0], "Comments");

/* ── metric values ── */

group("metric values");
near("conversion as a fraction", app.readMetric("conversion", "0.14").value, 0.14);
near("conversion as points", app.readMetric("conversion", "14").value, 0.14);
near("conversion as text percent", app.readMetric("conversion", "14%").value, 0.14);
ok("percent conversion is called out", app.readMetric("conversion", "14").note !== null);
ok("fractional conversion is not", app.readMetric("conversion", "0.14").note === null || app.readMetric("conversion", "0.14").note === undefined);
ok("conversion over 100% refused", !!app.readMetric("conversion", "140").error);
ok("negative traffic refused", !!app.readMetric("traffic", "-10").error);
ok("words refused", !!app.readMetric("sales", "tbc").error);
eq("blank is simply absent", app.readMetric("sales", "").value, null);
eq("zero is a real target", app.readMetric("sales", "0").value, 0);

/* ── the arithmetic between the six ── */

group("target arithmetic");
var consistent = { traffic: 26000, conversion: 0.14, upt: 1.85, asp: 27.05, sales: 182182, sot: 7.007 };
near("sales from the drivers", app.impliedSales(consistent), 26000 * 0.14 * 1.85 * 27.05);
near("sot is sales over traffic", app.impliedSot(consistent), 182182 / 26000);
eq("a consistent row raises nothing", app.checksFor(consistent).filter(function (c) { return c.off; }).length, 0);

var wrongSales = { traffic: 26000, conversion: 0.14, upt: 1.85, asp: 27.05, sales: 250000 };
var salesCheck = app.checksFor(wrongSales).filter(function (c) { return c.off; });
eq("an impossible sales figure is caught", salesCheck.length, 1);
eq("and named", salesCheck[0].label, "Sales");

var wrongSot = { traffic: 26000, sales: 182000, sot: 12 };
var sotCheck = app.checksFor(wrongSot).filter(function (c) { return c.off; });
eq("an sot that is not sales over traffic is caught", sotCheck.length, 1);
eq("and named", sotCheck[0].label, "SOT");

eq("half a row is incomplete, not wrong", app.checksFor({ traffic: 26000, sales: 182000 }).length, 0);
eq("an empty row raises nothing", app.checksFor({}).length, 0);
eq("rounding is not nagged about", app.checksFor({ traffic: 26000, conversion: 0.14, upt: 1.85, asp: 27.05, sales: 182000 })
  .filter(function (c) { return c.off; }).length, 0);

/* ── tidying values on the way in ── */

group("tidying");
eq("channel spelling", app.matchChannel("outlet"), "Outlet");
eq("channel abbreviation", app.matchChannel("SIS"), "Concession");
eq("channel synonym", app.matchChannel("Online"), "Ecommerce");
eq("unknown channel left alone", app.matchChannel("Wholesale"), "");
eq("status yes", app.normaliseStatus("Yes"), "active");
eq("status trading", app.normaliseStatus("Trading"), "active");
eq("status closed", app.normaliseStatus("CLOSED"), "closed");
eq("date iso", app.cleanDate("2019-03-14"), "2019-03-14");
eq("date uk", app.cleanDate("14/03/2019"), "2019-03-14");
eq("date serial", app.cleanDate(43538), "2019-03-14");
eq("date rubbish", app.cleanDate("soon"), "");

/* ── building rows from a sheet ── */

group("building rows");
var storeItems = app.buildStoreRows(storesSheet, app.detectLayout(storesSheet, null));
eq("one store built", storeItems.filter(function (i) { return i.row; }).length, 1);
eq("id read", storeItems[0].row.storeId, "S001");
eq("channel tidied", storeItems[0].row.storeChannel, "Retail");

var nameless = app.buildStoreRows([["Store ID", "Store Name", "Manager"], ["S009", "", "X"]],
  app.detectLayout([["Store ID", "Store Name", "Manager"], ["S009", "", "X"]], null));
ok("a store with no name is rejected", !!nameless[0].bad);

var known = { S001: true };
var built = app.buildTargetRows(longSheet, longLayout, null, null, known);
eq("one store-month built", built.items.filter(function (i) { return i.row; }).length, 1);
near("sales read", built.items[0].row.sales, 182000);
near("conversion kept as a fraction", built.items[0].row.conversion, 0.14);

var orphan = app.buildTargetRows(
  [["Store ID", "Month", "Sales Target"], ["S404", "2026-03", "1000"]],
  app.detectLayout([["Store ID", "Month", "Sales Target"], ["S404", "2026-03", "1000"]], null),
  null, null, known);
ok("targets for an unknown store are rejected", !!orphan.items[0].bad);
ok("with a reason that says what to do", /import stores first/.test(orphan.items[0].bad));

var wideBuilt = app.buildTargetRows(wideSheet, wideLayout, null, "sales", known);
eq("a wide row becomes four store-months", wideBuilt.items.filter(function (i) { return i.row; }).length, 4);
near("march picked out of the grid", wideBuilt.items.filter(function (i) {
  return i.row && i.row.month === "2026-03";
})[0].row.sales, 182000);

var stackedBuilt = app.buildTargetRows(stacked, stackedLayout, null, null, known);
var jan = stackedBuilt.items.filter(function (i) { return i.row && i.row.month === "2026-01"; })[0].row;
near("stacked metrics land on one row: sales", jan.sales, 150000);
near("stacked metrics land on one row: traffic", jan.traffic, 23000);

/* ── merging two copies ── */

group("merge");
function mergeInto(mine, theirs) {
  var result = mine.slice();
  app.mergeById(result, theirs, "id", function (next) { result = next; });
  return result;
}
var older = [{ id: "a", sales: 1, updatedAt: "2026-01-01T00:00:00.000Z" }];
var newer = [{ id: "a", sales: 2, updatedAt: "2026-02-01T00:00:00.000Z" }];
eq("newer wins", mergeInto(older, newer)[0].sales, 2);
eq("older does not win", mergeInto(newer, older)[0].sales, 2);
eq("unseen records arrive", mergeInto(older, [{ id: "b", updatedAt: "2026-01-01T00:00:00.000Z" }]).length, 2);
var tomb = [{ id: "a", deleted: true, updatedAt: "2026-03-01T00:00:00.000Z" }];
eq("a deletion travels", mergeInto(newer, tomb)[0].deleted, true);
eq("and an old backup cannot undo it", mergeInto(tomb, older)[0].deleted, true);

/* ── result ── */

console.log("");
if (failures) {
  console.log(failures + " of " + checks + " checks failed.");
  process.exit(1);
}
console.log("All " + checks + " checks passed.");
