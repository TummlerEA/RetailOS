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
near("conversion written with a percent sign", app.readMetric("conversion", "14%").value, 0.14);
// Reading a cell no longer decides the unit — a bare 14 could be 14% or a
// genuine 1400%, and only the rest of the row can say. See "conversion
// units" below, where that decision is made and tested.
near("a bare number is carried through as written", app.readMetric("conversion", "14").value, 14);
ok("a negative conversion is still refused", !!app.readMetric("conversion", "-1").error);
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
var storeItems = app.buildStoreRows(storesSheet, app.detectLayout(storesSheet, null)).items;
eq("one store built", storeItems.filter(function (i) { return i.row; }).length, 1);
eq("id read", storeItems[0].row.storeId, "S001");
eq("channel tidied", storeItems[0].row.storeChannel, "Retail");

var nameless = app.buildStoreRows([["Store ID", "Store Name", "Manager"], ["S009", "", "X"]],
  app.detectLayout([["Store ID", "Store Name", "Manager"], ["S009", "", "X"]], null)).items;
ok("a store with no name is rejected", !!nameless[0].bad);

var branded = [["Store ID", "Store Name", "Fascia", "Channel"],
               ["S010", "Bicester", "Levi's", "Outlet"]];
var brandedRow = app.buildStoreRows(branded, app.detectLayout(branded, null)).items[0].row;
eq("a Fascia column is read as the brand", brandedRow.storeBrand, "Levis");
eq("and the channel is still its own thing", brandedRow.storeChannel, "Outlet");

var located = [["Store ID", "Store Name", "Address", "Lat", "Long"],
               ["S007", "Tverskaya", "12 Tverskaya St", "55.7446675", "37.5658937"]];
var locatedRow = app.buildStoreRows(located, app.detectLayout(located, null)).items[0].row;
eq("Lat is recognised as latitude", locatedRow.latitude, "55.7446675");
eq("Long is recognised as longitude", locatedRow.longitude, "37.5658937");
eq("and the address comes with it", locatedRow.address, "12 Tverskaya St");

var swapped = [["Store ID", "Store Name", "Latitude", "Longitude"],
               ["S008", "Somewhere", "137.5", "137.5"]];
var swappedRow = app.buildStoreRows(swapped, app.detectLayout(swapped, null)).items[0].row;
eq("a latitude past the pole is left out", swappedRow.latitude, undefined);
eq("while the same number is a valid longitude", swappedRow.longitude, "137.5");

var known = app.storeIndex([{ storeId: "S001", storeName: "Oxford Street" }]);
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

/* ── whole dates in the month column ── */

group("day-first dates");
eq("dotted, as Excel writes it here", app.parseMonth("01.08.2026", 2026).key, "2026-08");
eq("slashed", app.parseMonth("01/08/2026", 2026).key, "2026-08");
eq("dashed", app.parseMonth("01-08-2026", 2026).key, "2026-08");
eq("single digits", app.parseMonth("1.8.2026", 2026).key, "2026-08");
eq("a two-digit year", app.parseMonth("01.08.26", 2026).key, "2026-08");
eq("mid-month, since only the month is kept", app.parseMonth("15.08.2026", 2026).key, "2026-08");
eq("the last of the month", app.parseMonth("31.12.2026", 2026).key, "2026-12");
// 15 cannot be a month, so this one is unambiguous whatever the convention.
eq("a file written the American way still lands right", app.parseMonth("08/15/2026", 2026).key, "2026-08");
eq("and the year-first forms still work", app.parseMonth("2026-08-01", 2026).key, "2026-08");
eq("as do month and year alone", app.parseMonth("08.2026", 2026).key, "2026-08");
ok("nonsense is still refused", !!app.parseMonth("abc", 2026).error);

/* ── a real file, exactly as it arrives ── */

group("a real targets file");
var realRows = [
  ["month", "store_id", "store_name", "sales", "trafic", "conversion", "upt", "asp", "sot"],
  ["01.08.2026", "0Ц-000018", "JNS МОС Авиапарк", "15112500", "10000", "0.075", "1.55", "13000", " 1,511 "],
  ["01.08.2026", "0Ц-000019", "JNS МОС Атриум", "9741600", "4500", "0.11", "1.6", "12300", " 2,165 "]
];
var realLayout = app.detectLayout(realRows, null);
eq("it reads as one row per store-month", realLayout.kind, "targets-long");
eq("nothing in the header is ignored", realLayout.ignored.length, 0);
ok("even though traffic is spelled trafic", realLayout.metricCols.traffic === 4);

var realBuilt = app.buildTargetRows(realRows, realLayout, null, null,
  app.storeIndex([{ storeId: "0Ц-000018", storeName: "JNS МОС Авиапарк" },
                   { storeId: "0Ц-000019", storeName: "JNS МОС Атриум" }]));
eq("both rows come in", realBuilt.items.filter(function (i) { return i.row; }).length, 2);
var first = realBuilt.items[0].row;
eq("a Cyrillic store ID survives intact", first.storeId, "0Ц-000018");
eq("the month", first.month, "2026-08");
near("sales", first.sales, 15112500);
near("traffic", first.traffic, 10000);
near("conversion stays the fraction it already was", first.conversion, 0.075);
near("ASP", first.asp, 13000);
near("SOT, with its spaces and thousands comma", first.sot, 1511);

// Sales = Traffic x Conversion x UPT x ASP, to the rouble.
near("the file's own arithmetic holds", app.impliedSales(first), 15112500);
eq("so nothing is flagged as inconsistent",
   app.checksFor(first).filter(function (c) { return c.off; }).length, 0);

/* ── Russian headers, as a fallback behind the English ones ── */

group("Cyrillic headers");
var ruTargets = [
  ["Месяц", "Код магазина", "Наименование", "Продажи", "Трафик", "Конверсия", "УПТ", "Средняя цена", "СОТ"],
  ["01.08.2026", "0Ц-000018", "JNS МОС Авиапарк", "15112500", "10000", "0.075", "1.55", "13000", " 1,511 "]
];
var ruLayout = app.detectLayout(ruTargets, null);
eq("a wholly Russian header row reads as targets", ruLayout.kind, "targets-long");
eq("and nothing in it is ignored", ruLayout.ignored.length, 0);
var ruRow = app.buildTargetRows(ruTargets, ruLayout, null, null, app.storeIndex([{ storeId: "0Ц-000018", storeName: "JNS МОС Авиапарк" }])).items[0].row;
eq("Месяц is the month", ruRow.month, "2026-08");
near("Продажи is sales", ruRow.sales, 15112500);
near("Трафик is traffic", ruRow.traffic, 10000);
near("Конверсия is conversion", ruRow.conversion, 0.075);
near("УПТ is UPT", ruRow.upt, 1.55);
near("Средняя цена is ASP", ruRow.asp, 13000);
near("СОТ is SOT", ruRow.sot, 1511);

// ATV, not ASP: средний чек is ASP x UPT. Mapping it would put a number
// half again too big into the column and the checks would flag the row.
eq("средний чек is left alone rather than taken for ASP",
   app.detectLayout([["Месяц", "Код магазина", "Средний чек"], ["01.08.2026", "S1", "500"]], null).ignored.length, 1);

var ruStores = [
  ["Код магазина", "Наименование", "Бренд", "Канал", "Управляющий", "Адрес", "Широта", "Долгота", "Статус", "Площадь"],
  ["0Ц-000018", "JNS МОС Авиапарк", "Найк", "Розница", "И. Петров", "Ходынский б-р, 4", "55.7446675", "37.5658937", "Действующий", "320"]
];
var ruStoreLayout = app.detectLayout(ruStores, null);
eq("a Russian store sheet is recognised", ruStoreLayout.kind, "stores");
eq("with every column understood", ruStoreLayout.ignored.length, 0);
var ruStore = app.buildStoreRows(ruStores, ruStoreLayout).items[0].row;
eq("the ID", ruStore.storeId, "0Ц-000018");
eq("the name is kept in its own alphabet", ruStore.storeName, "JNS МОС Авиапарк");
eq("Найк becomes the brand we store", ruStore.storeBrand, "Nike");
eq("Розница becomes the channel we store", ruStore.storeChannel, "Retail");
eq("Действующий becomes active", ruStore.status, "active");
eq("Широта is latitude", ruStore.latitude, "55.7446675");
eq("Адрес is the address", ruStore.address, "Ходынский б-р, 4");
near("Площадь is the sales area", ruStore.salesArea, 320);

// The English spellings must still win where both could apply.
eq("English headers are untouched by any of this",
   app.detectLayout([["month", "store_id", "sales"], ["01.08.2026", "S1", "1"]], null).kind, "targets-long");

/* ── the store name as a check on the store ID ── */

group("name against ID");
var twoStores = app.storeIndex([
  { storeId: "0Ц-000018", storeName: "JNS МОС Авиапарк" },
  { storeId: "0Ц-000019", storeName: "JNS МОС Атриум" }
]);
function targetsWith(idCell, nameCell) {
  var rows = [["month", "store_id", "store_name", "sales"],
              ["01.08.2026", idCell, nameCell, "1000"]];
  return app.buildTargetRows(rows, app.detectLayout(rows, null), null, null, twoStores).items[0];
}

ok("a matching name lets the row through", !!targetsWith("0Ц-000018", "JNS МОС Авиапарк").row);
ok("case and spacing differences are not a mismatch", !!targetsWith("0Ц-000018", "jns  мос авиапарк").row);

// The whole reason the name column is in the file: catching a mis-keyed ID.
var swapped = targetsWith("0Ц-000018", "JNS МОС Атриум");
ok("a name belonging to a different store stops the row", !!swapped.bad);
ok("and the message names both, so it is obvious which is wrong",
   /0Ц-000018/.test(swapped.bad) && /Авиапарк/.test(swapped.bad) && /Атриум/.test(swapped.bad), swapped.bad);

var unknownName = targetsWith("0Ц-000018", "Somewhere Else");
ok("a name matching no store at all also stops the row", !!unknownName.bad);

/* ── a file with only a name ── */

group("name as the key");
function byNameOnly(nameCell, index) {
  var rows = [["month", "store_name", "sales"], ["01.08.2026", nameCell, "1000"]];
  return app.buildTargetRows(rows, app.detectLayout(rows, null), null, null, index).items[0];
}
eq("a unique name stands in for the ID", byNameOnly("JNS МОС Атриум", twoStores).row.storeId, "0Ц-000019");
ok("an unknown name is refused", !!byNameOnly("Nowhere", twoStores).bad);

// Two stores sharing a name is not something to resolve by guessing.
var ambiguous = app.storeIndex([
  { storeId: "A1", storeName: "Central" },
  { storeId: "A2", storeName: "Central" }
]);
var clash = byNameOnly("Central", ambiguous);
ok("a name shared by two stores is refused", !!clash.bad);
ok("and says to add an ID column", /store ID column/.test(clash.bad), clash.bad);

/* ── blanks that are not empty cells ── */

group("blank markers");
["-", " - ", "  -   ", "–", "—", "n/a", "N/A", "#N/A", "нет"].forEach(function (v) {
  eq(JSON.stringify(v) + " is an empty cell, not a broken number",
     JSON.stringify(app.readMetric("conversion", v)), '{"value":null}');
});
eq("a real number is still read", app.readMetric("sales", "1,234").value, 1234);
ok("and real rubbish is still an error", !!app.readMetric("sales", "tbc").error);

/* ── which unit a conversion is in ── */

group("conversion units");
function convOf(cells) {
  var rows = [["month", "store_id", "sales", "traffic", "conversion", "upt", "asp"],
              ["01.01.2020", "S1"].concat(cells)];
  var idx = app.storeIndex([{ storeId: "S1", storeName: "" }]);
  return app.buildTargetRows(rows, app.detectLayout(rows, null), null, null, idx);
}

// A rate above 1 that the row's own arithmetic confirms: 1000 x 1.128 x 1.5
// x 100 = 169,200. Dividing by 100 would make this row wrong by 99%.
var above = convOf(["169200", "1000", "1.128", "1.5", "100"]);
near("a conversion above 100% is kept when the row's arithmetic says so",
     above.items[0].row.conversion, 1.128);
eq("and it is not reported as a correction", JSON.stringify(above.notes), "{}");

// The same shape, but the sales figure agrees with percentage points:
// 1000 x 0.075 x 1.5 x 100 = 11,250.
var points = convOf(["11250", "1000", "7.5", "1.5", "100"]);
near("percentage points are converted when the arithmetic says so",
     points.items[0].row.conversion, 0.075);
ok("and that is reported", !!points.notes["read as percentage points"]);

// Nothing to check against: the old assumption still applies, and is said.
var alone = [["month", "store_id", "conversion"], ["01.01.2020", "S1", "7.5"]];
var lonely = app.buildTargetRows(alone, app.detectLayout(alone, null), null, null,
                                 app.storeIndex([{ storeId: "S1", storeName: "" }]));
near("with nothing to check against, above 1 is taken as percentage points",
     lonely.items[0].row.conversion, 0.075);
ok("and said so", !!lonely.notes["read as percentage points"]);

near("a plain fraction is untouched", convOf(["11250", "1000", "0.075", "1.5", "100"]).items[0].row.conversion, 0.075);

/* ── the same store-month twice in one file ── */

group("duplicate store-months");
var twice = [["month", "store_id", "sales"],
             ["01.03.2022", "S1", "2045535"],
             ["01.03.2022", "S1", "1223775"]];
var dup = app.buildTargetRows(twice, app.detectLayout(twice, null), null, null,
                              app.storeIndex([{ storeId: "S1", storeName: "" }]));
eq("they collapse to one store-month", dup.items.filter(function (i) { return i.row; }).length, 1);
near("the last one in the file wins", dup.items[0].row.sales, 1223775);
ok("but it is no longer silent",
   !!dup.notes["store-months appear more than once in this file — the last value in the file wins"]);

/* ── brands ── */

group("brands");
eq("the five, exactly as written", app.BRANDS.join("|"), "Multi|Asics|Under Armour|Levis|Nike");
eq("an exact match", app.matchBrand("Nike"), "Nike");
eq("case and spacing do not matter", app.matchBrand("under armour"), "Under Armour");
eq("nor does the missing space", app.matchBrand("UnderArmour"), "Under Armour");
eq("the American spelling", app.matchBrand("Under Armor"), "Under Armour");
eq("the initials", app.matchBrand("UA"), "Under Armour");
eq("an apostrophe is punctuation", app.matchBrand("Levi's"), "Levis");
eq("and the full name", app.matchBrand("Levi Strauss"), "Levis");
eq("multi-brand written out", app.matchBrand("Multi-brand"), "Multi");
eq("a brand that is not ours is not guessed at", app.matchBrand("Adidas"), "");
eq("nor is an empty cell", app.matchBrand(""), "");

// The two are different questions about the same store.
ok("brand is not a channel", app.CHANNELS.indexOf("Nike") < 0);
ok("and a channel is not a brand", app.BRANDS.indexOf("Outlet") < 0);

/* ── a value outside the vocabulary ── */

group("unknown channel or brand");
var offList = [["Store ID", "Store Name", "Channel", "Brand"],
               ["S020", "Aviapark", "Nike", "Nike"]];
var offBuilt = app.buildStoreRows(offList, app.detectLayout(offList, null));
var offRow = offBuilt.items[0].row;
eq("the store still comes in", offRow.storeId, "S020");
eq("the brand is understood", offRow.storeBrand, "Nike");
// A brand is not a channel. Writing it through was how store_channel came
// to hold brand names, which the database then refused at sync time.
eq("a brand sitting in the channel column is left blank", offRow.storeChannel, "");
ok("and the import says so",
   !!offBuilt.notes["values were not a channel this app knows, and were left blank"]);

var goodPair = [["Store ID", "Store Name", "Channel", "Brand"], ["S021", "Bicester", "Outlet", "Levis"]];
var goodBuilt = app.buildStoreRows(goodPair, app.detectLayout(goodPair, null));
eq("a real channel is kept", goodBuilt.items[0].row.storeChannel, "Outlet");
eq("alongside its brand", goodBuilt.items[0].row.storeBrand, "Levis");
eq("with nothing to report", JSON.stringify(goodBuilt.notes), "{}");

/* ── coordinates ── */

group("coordinates");
eq("a plain latitude", app.cleanCoordinate("55.7446675", 90), "55.7446675");
eq("precision is kept exactly, not rounded through a float", app.cleanCoordinate("55.74466750", 90), "55.74466750");
eq("a longitude", app.cleanCoordinate("37.5658937", 180), "37.5658937");
eq("Excel handing it over as a number", app.cleanCoordinate(37.5658937, 180), "37.5658937");
eq("a negative stays negative", app.cleanCoordinate("-0.1276", 180), "-0.1276");
eq("degrees and a hemisphere are dropped", app.cleanCoordinate("55.7446675° N", 90), "55.7446675");
eq("south is negative", app.cleanCoordinate("33.9249 S", 90), "-33.9249");
eq("west is negative", app.cleanCoordinate("118.2437 W", 180), "-118.2437");
eq("a latitude past the pole is not a latitude", app.cleanCoordinate("137.5", 90), null);
eq("but that value is a fine longitude", app.cleanCoordinate("137.5", 180), "137.5");
eq("past the antimeridian is not", app.cleanCoordinate("181.2", 180), null);
eq("words are not coordinates", app.cleanCoordinate("tbc", 90), null);
eq("nor is an empty cell", app.cleanCoordinate("", 90), null);
eq("nor a stray dash", app.cleanCoordinate("-", 90), null);

/* ── translating to and from Postgres ── */

group("server shapes");

var storeHere = {
  storeId: "S001", storeName: "Oxford Street", storeManager: "A Patel",
  storeChannel: "Retail", storeBrand: "Nike", country: "GB", status: "active",
  openDate: "2019-04-01", closeDate: "", salesArea: 240.5,
  address: "1 Oxford Street", latitude: "51.5152300", longitude: "-0.1419300",
  updatedAt: "2026-03-01T09:00:00.000Z"
};
var storeThere = app.storeToRemote(storeHere);
eq("store id", storeThere.store_id, "S001");
eq("name", storeThere.store_name, "Oxford Street");
eq("channel", storeThere.store_channel, "Retail");
eq("brand travels separately", storeThere.store_brand, "Nike");
eq("an empty date becomes null, not an empty string", storeThere.close_date, null);
eq("sales area is a number", storeThere.sales_area, 240.5);
eq("the address goes up", storeThere.address, "1 Oxford Street");
eq("latitude stays text, so its precision survives", storeThere.latitude, "51.5152300");
eq("longitude too", storeThere.longitude, "-0.1419300");
eq("not deleted", storeThere.deleted, false);

// store_name is NOT NULL, and a tombstone has no name to give it.
var tombThere = app.storeToRemote({ storeId: "S009", deleted: true, updatedAt: "2026-03-01T09:00:00.000Z" });
eq("a tombstone still satisfies NOT NULL", tombThere.store_name, "S009");
eq("a tombstone still satisfies the status check", tombThere.status, "active");
eq("and says it is deleted", tombThere.deleted, true);

var storeBack = app.storeFromRemote(storeThere);
eq("store round-trips: id", storeBack.storeId, "S001");
eq("store round-trips: manager", storeBack.storeManager, "A Patel");
eq("store round-trips: brand", storeBack.storeBrand, "Nike");
eq("store round-trips: area", storeBack.salesArea, 240.5);
eq("store round-trips: latitude, still as text", storeBack.latitude, "51.5152300");
eq("store round-trips: address", storeBack.address, "1 Oxford Street");
eq("a null column comes back absent, not null", "closeDate" in storeBack, false);
eq("a deleted row comes back as a tombstone", app.storeFromRemote({ store_id: "S009", deleted: true, updated_at: "2026-03-01T09:00:00Z" }).deleted, true);

var targetHere = {
  id: "S001|2026-03", storeId: "S001", month: "2026-03",
  sales: 182000, traffic: 23000, conversion: 0.14, upt: 1.8, asp: 31.5,
  updatedAt: "2026-03-01T09:00:00.000Z"
};
var targetThere = app.targetToRemote(targetHere);
eq("the month becomes a real first-of-month date", targetThere.month, "2026-03-01");
eq("conversion stays a fraction", targetThere.conversion, 0.14);
eq("a metric with no value is sent as null, so clearing one travels", targetThere.sot, null);

var targetBack = app.targetFromRemote(targetThere);
eq("target round-trips: key", targetBack.id, "S001|2026-03");
eq("target round-trips: month", targetBack.month, "2026-03");
near("target round-trips: sales", targetBack.sales, 182000);
eq("a null metric comes back absent", "sot" in targetBack, false);

// Postgres timestamps arrive with an offset and six decimals; the browser
// writes Z and three. The merge compares them as strings, so both sides
// have to be in one format before they meet.
var normalised = app.storeFromRemote({ store_id: "S1", store_name: "x", updated_at: "2026-03-01T09:00:00.123456+00:00" });
eq("timestamps are normalised on the way in", normalised.updatedAt, "2026-03-01T09:00:00.123Z");
ok("so a local write later the same second still looks newer",
   "2026-03-01T09:00:00.900Z" > normalised.updatedAt);

/* ── deciding what to send ── */

group("what to push");
var mineNow = [
  { storeId: "A", updatedAt: "2026-02-01T00:00:00.000Z" },
  { storeId: "B", updatedAt: "2026-02-01T00:00:00.000Z" },
  { storeId: "C", updatedAt: "2026-02-01T00:00:00.000Z" }
];
var theirsNow = [
  { storeId: "A", updatedAt: "2026-01-01T00:00:00.000Z" },
  { storeId: "B", updatedAt: "2026-02-01T00:00:00.000Z" }
];
var toPush = app.newerHere(mineNow, theirsNow, "storeId").map(function (r) { return r.storeId; });
eq("a row the server has an older copy of is sent", toPush.indexOf("A") >= 0, true);
eq("a row the server already matches is not", toPush.indexOf("B") >= 0, false);
eq("a row the server has never seen is sent", toPush.indexOf("C") >= 0, true);
eq("nothing else is sent", toPush.length, 2);

/* ── what the user is told when it goes wrong ── */

group("failure messages");
ok("a wrong password does not leak which half was wrong",
   app.authMessage(400, { error: "invalid_grant" }).indexOf("email and password did not match") >= 0);
ok("rate limiting says to wait", app.authMessage(429, {}).indexOf("Wait a minute") >= 0);
ok("a refusal names the likely cause", app.restMessage(403, null).indexOf("may not have access") >= 0);
ok("a constraint violation is passed through, not swallowed",
   app.restMessage(400, { message: "violates check constraint", details: "targets_conversion_is_a_fraction" })
     .indexOf("targets_conversion_is_a_fraction") >= 0);

/* ── result ── */

console.log("");
if (failures) {
  console.log(failures + " of " + checks + " checks failed.");
  process.exit(1);
}
console.log("All " + checks + " checks passed.");
