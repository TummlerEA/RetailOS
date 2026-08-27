# RetailOS

Store master data and monthly operational targets for a ~30-store clothing,
footwear and accessories retailer. Plain HTML, CSS and JavaScript — no
framework, no build step, no dependencies, nothing to install. Open
`index.html` and it runs.

Everything is on one screen's worth of tabs: **Stores**, **Targets**,
**Import** and **Settings**.

## What it does today

- **Stores.** ID, name, manager, brand, channel, country, address, latitude,
  longitude, status, opening and closing dates, sales area. Brand is the name
  over the door (Multi, Asics, Under Armour, Levis, Nike); channel is how the
  store trades (Retail, Outlet, Concession, Franchise, Ecommerce, Pop-up).
  They are deliberately two fields: the same brand can be full-price in one
  place and an outlet in another, and both slices get asked for. The store ID is
  the join key everything else hangs off, so it is fixed once a store exists
  and cannot be retyped. Coordinates are kept as text so the precision given
  survives exactly, but only a real coordinate is accepted — both the
  importer and the database check the range.
- **Targets, by store by calendar month.** Sales, Traffic, Conversion, UPT,
  ASP and SOT — laid out either as one month across every store, or one
  store across every month, and editable in place like a spreadsheet.
- **Loading from Excel.** Either paste a block of cells straight out of
  Excel, or pick an `.xlsx` or `.csv` file. Both layouts real target files
  arrive in are understood: one row per store-month, and months across the
  top. Dates are read day-first — `01.08.2026`, `01/08/2026` and `2026-08-01`
  all mean August 2026 — and headers are matched loosely enough that a
  misspelt `trafic` still lands on Traffic. Russian headers work as a
  fallback behind the English ones — `Продажи`, `Трафик`, `Конверсия`,
  `Код магазина`, `Бренд`, `Широта` — and so do the values inside them, so
  `Розница` becomes Retail and `Действующий` becomes active. `Средний чек`
  is deliberately not treated as ASP: it is the average transaction value,
  which is ASP x UPT. A store name sitting next to a store ID is treated as
  a check on it: if the two disagree the row is held back and the preview
  says which store that ID really is. A targets file carrying only a name
  still loads, as long as the name picks out exactly one store. Nothing is written until a preview has shown exactly what would
  change.
- **Export.** A JSON backup, and two flat CSVs shaped for Power BI.
- **Sync.** Sign in and the same data is on the laptop, the phone and in
  Postgres for Power BI to read. Signed out it still works exactly as
  before, on that device only.

### Conversion, and which unit it is in

Conversion is stored as a rate: 0.075, not 7.5. A cell written `7.50%` is
unambiguous. A bare `7.5` is not — it could be 7.5% or a genuine 750% — so
the unit is decided per row rather than by a threshold: whichever reading
reproduces Sales = Traffic × Conversion × UPT × ASP is the one that was
meant. Only when the row has nothing to check against is a value above 1
assumed to be percentage points, and then the import says how many.

Above 100% is unusual but real, and is kept. A store whose counter
under-reports sells to more people than it counted, and real target files
carry rows like that.

## The six targets are not six independent numbers

```
Transactions = Traffic × Conversion
Units        = Transactions × UPT
Sales        = Units × ASP
∴ Sales      = Traffic × Conversion × UPT × ASP
  SOT        = Sales ÷ Traffic   ( = Conversion × UPT × ASP )
```

All six are editable, because that is how target-setting actually happens —
a sales number lands first and the drivers get backfilled. But where both
sides of an identity are filled in and they disagree by more than 1%, the
**Check** column says so, naming which one is out and by how much. It never
silently overwrites what somebody typed; it only refuses to pretend the
numbers add up when they do not.

Conversion is stored as a decimal fraction (`0.14`) and shown in the grid as
percentage points (`14`), because nobody types 0.14 when they mean 14%.
Imports normalise both, and say when they have.

## Loading data from Excel

The Import tab takes two routes in. **Pasting** is the fast one: select the
cells in Excel including the header row, copy, paste. **A file** — `.xlsx`,
`.xlsm`, `.csv` or `.tsv` — is the one for a workbook somebody emailed over.

Three layouts are recognised from the header row alone:

| Layout | Looks like |
| --- | --- |
| Stores | `Store ID`, `Store Name`, `Manager`, `Channel`, … |
| Targets, long | `Store ID`, `Month`, `Sales Target`, `Traffic Target`, … |
| Targets, wide | `Store ID`, *(`Metric`)*, `Jan-26`, `Feb-26`, `Mar-26`, … |

Wide is supported because that is how target files are actually built and
reviewed. A tool that insists on unpivoted data first stops being used.

Header names are matched loosely — `Store ID`, `storeid`, `Store No` and
`Branch` all land in the same place. Months are read from `2026-03`,
`Mar-26`, `March 2026`, `03/2026`, `202603` and real Excel dates, with a
"year to assume" for a bare `Mar`. Numbers survive thousands separators,
currency symbols, `(1,200)` for a negative and continental decimal commas.
Channels and statuses are mapped onto a fixed vocabulary, so `SIS` becomes
`Concession` and `Trading` becomes `active` rather than becoming a fourth
spelling in the Power BI report.

Then it shows you what it found, and waits:

- how many rows are **new**, **changed** and **already the same**;
- for each change, the old value struck through beside the new one;
- every value it **left out**, and why — a store not in the store list, a
  month it could not read, a cell someone typed a word into;
- which columns it **ignored** entirely.

Only then does Apply write anything. Every write is an upsert keyed on the
store, or on the store and month, so importing the same file twice is a
no-op the second time rather than a pile of duplicates. Values merge field
by field: a file carrying only Traffic does not wipe the Sales already
recorded for that month.

A value that cannot be read is left out on its own — the rest of its row
still comes in. A row for a store that does not exist is refused outright,
with a message saying to import the stores first, because targets nothing
joins to are worse than no targets.

### Reading .xlsx without a library

An `.xlsx` is a ZIP full of XML, and every current browser can inflate a raw
DEFLATE stream by itself (`DecompressionStream`). So this app reads one
directly: unzip the four parts that matter, parse them with the `DOMParser`
that is already there, and hand back rows of cells. Number formats are read
far enough to tell a date from a plain number, which is what a month header
needs. No SheetJS, no bundler, nothing to keep patched.

A browser too old for `DecompressionStream` will say so and point at the CSV
and paste routes, which reach the same place.

## Where the data lives

In this browser's `localStorage` always, and in Supabase as well once
someone signs in.

Signed out, there is exactly one copy and two things are worth being blunt
about:

- **Clearing site data, or changing laptop, destroys it.** Export a JSON
  backup.
- **Safari deletes it.** Under Intelligent Tracking Prevention, storage a
  script wrote is evicted after about seven days without a visit. An iPad
  used once a week can come back empty.

Signing in is what fixes both, and it is the reason to do it early.

Restoring a backup **merges** rather than replaces. Every record carries
`updatedAt`, and deleting leaves a tombstone rather than dropping the row,
so the newer version of each record wins whichever order two files are
applied in — and an out-of-date backup cannot resurrect something deleted
or undo a newer edit. That is what makes passing a JSON file between two
machines work today, and it is the same rule sync uses.

## Sync

The app stays local-first. Every screen still reads and writes the browser
copy synchronously, so the phone keeps working with no signal and none of
the screen code had to change. Sync is a separate errand that runs on
opening the app, a second and a half after any edit, and whenever **Sync
now** is pressed:

1. Pull every row from `stores` and `targets`.
2. Merge them in by the last-write-wins rule above.
3. Push back whatever turned out to be newer here.

Because the merge is order-independent, it does not matter which device
syncs first or how long one of them was offline. Stores are pushed before
targets, since a target row cannot reference a store the server has not been
told about.

The browser talks to PostgREST directly over `fetch` — no SDK, no bundle,
and one fewer dependency to keep patched. Sign-in is Supabase Auth; the
access token lives in `localStorage` and is refreshed automatically when it
expires. `config.js` holds the project URL and the publishable key, both of
which are public by design: what protects the data is row-level security
plus self-signup being turned off, not the key. The secret key must never
appear in any file the browser can read.

`supabase/SETUP.md` walks through creating the project; `supabase/schema.sql`
is the whole database.

## Where it is going

1. **Done** — offline, one browser, Excel in, CSV and JSON out.
2. **Done** — Supabase behind it: Postgres so Power BI connects natively,
   PostgREST so there is no server code of ours to write, and real logins.
3. **Next** — Power BI reading the `targets_report` view directly, so the
   CSV export stops being the route into the report.
4. **Later** — actuals joined alongside targets; store-manager logins with
   row-level security narrowed to their own store; a strategic-target module
   separate from these operational ones.

### The CSVs are shaped for Power BI

One flat table each, `storeId` as a stable join key, conversion as a decimal
fraction, and the month as both `2026-03` and a real `2026-03-01` date so it
folds onto a date table without being parsed out of a string. `impliedSales`
and `salesVariancePct` travel with the targets so the consistency check is
visible in the report, not only in the app.

Actuals are deliberately not here. They come from the POS, into Power BI,
and join to these targets on `storeId` and `monthStart`. This app is the
system of record for the things the POS does not know.

## Running it

Open `index.html`. That is all — there is no server, no `npm install`, no
build.

One caveat: opened straight off the disk the page has a `file://` origin,
which some browsers refuse to let call out to Supabase. Everything except
sync works; to try sync locally, serve the folder instead —

```
python3 -m http.server 8000     # then open http://localhost:8000
```

## Putting it in front of people

GitHub Pages serves this repository as it stands. **Settings** → **Pages** →
Source **Deploy from a branch**, the default branch, folder **/ (root)**.
A minute later it is at `https://<user>.github.io/RetailOS/`, which is also
the URL to open on a phone — Safari's **Share** → **Add to Home Screen**
gives it an icon and its own window.

The repository is public, so `config.js` and the publishable key in it are
readable by anyone. That is how the key is meant to work. What stops a
stranger reading your targets is that every table needs a signed-in user and
self-signup is turned off, both of which `supabase/verify.sql` checks. The
secret key is the one that must never be committed, and is not.

## Tests

```
node test_logic.js      # numbers, months, layout detection, the arithmetic
node test_browser.js    # the real app in a real browser, including .xlsx
node test_version.js    # the release number agrees with itself
```

`test_logic.js` needs nothing but Node. `test_browser.js` needs Playwright
and a Chromium, and skips itself with a message when they are absent; it
drives the actual app against the `.xlsx` fixtures in `test/fixtures/`,
which `test/make_fixtures.py` regenerates (`pip install openpyxl`). The
fixtures deliberately contain the awkward cases: months as formatted dates
rather than text, conversion in percentage points, the data on the second
sheet behind a cover note, a store that does not exist, and a cell someone
typed `tbc` into.

The sync tests stub Supabase at `window.fetch` — the exact seam the app
talks through — so the merge, the choice of what to push, the shape of every
row and the error messages are all the real code, without writing to live
data. What a stub cannot check is that those rows satisfy the real schema,
so `supabase/verify.sql` does that half: paste it into the Supabase SQL
Editor and it checks the tables, the policies, that the anonymous role
reaches nothing, and that a signed-in user can write and read back — writing
nothing it does not delete again.

## Releasing

Bump the `?v=` on each asset in `index.html`, `VERSION` in `app.js` and
`version.json` to the same number, in one commit. The `?v=` is what makes
browsers fetch the new files. `test_version.js` fails if any of them
disagree.

## Known limits

- Calendar months only. A 4-5-4 retail calendar would need a period table;
  the month key is deliberately opaque to the rest of the app so that change
  stays contained in one place.
- One currency, set in Settings, for formatting only. Nothing is converted.
- Column mapping is automatic. Headers it does not recognise are reported as
  ignored rather than offered for mapping by hand.
- Targets are overwritten, not versioned — they are operational targets set
  at the end of each month and not revised. Strategic targets are a separate
  module, not built.
- Sync is whole-table: every row is pulled on each sync. At thirty stores
  and a few years of months that is a few hundred rows, so it is not worth
  the complexity of tracking a high-water mark until it is.
- Two people editing the same cell in the same minute is resolved by the
  clock, and a device with a badly wrong clock will win arguments it should
  not.
- A store's manager is a plain column, not a dated assignment, so it answers
  "who runs this store" and not "who ran it in March".
