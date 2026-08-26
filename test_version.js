/*
 * The three places a release number is written must agree, or a browser
 * will hold on to an old app.js next to a new index.html.
 *
 *   node test_version.js
 *
 * Releasing means bumping all three in one commit: the ?v= on both assets
 * in index.html, VERSION in app.js, and version.json.
 */
var fs = require("fs");
var path = require("path");

function read(name) { return fs.readFileSync(path.join(__dirname, name), "utf8"); }

var html = read("index.html");
var app = read("app.js");
var manifest = JSON.parse(read("version.json"));

var problems = [];

var assets = {};
html.replace(/(?:src|href)="(app\.js|style\.css)\?v=(\d+)"/g, function (all, file, version) {
  assets[file] = parseInt(version, 10);
  return all;
});

["app.js", "style.css"].forEach(function (file) {
  if (assets[file] === undefined) problems.push("index.html does not cache-bust " + file + " with ?v=");
});

var declared = /var VERSION = (\d+);/.exec(app);
if (!declared) problems.push("app.js has no `var VERSION = <n>;`");

var numbers = [manifest.version, assets["app.js"], assets["style.css"], declared && parseInt(declared[1], 10)]
  .filter(function (n) { return typeof n === "number" && !isNaN(n); });

if (numbers.length === 4 && new Set(numbers).size !== 1) {
  problems.push("These disagree — version.json " + manifest.version
    + ", app.js?v=" + assets["app.js"]
    + ", style.css?v=" + assets["style.css"]
    + ", VERSION in app.js " + declared[1]);
}

if (problems.length) {
  problems.forEach(function (p) { console.log("  FAIL  " + p); });
  process.exit(1);
}
console.log("Version " + manifest.version + " is stated the same in all four places.");
