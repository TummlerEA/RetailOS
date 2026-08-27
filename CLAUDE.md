# RetailOS — working notes

Store master data and monthly operational targets for a ~40-store clothing,
footwear and accessories retailer. Read `README.md` first; it explains what
the app does and why. This file is the short version of how to work on it.

## Shape

Plain HTML, CSS and JavaScript. **No framework, no build step, no
dependencies, nothing to install.** Open `index.html` and it runs. Keep it
that way — a library was rejected once already (SheetJS, for reading .xlsx)
and replaced with ~200 lines using `DecompressionStream` and `DOMParser`.

    index.html    app shell, four tabs, the store dialog
    app.js        one IIFE, everything, ~2600 lines
    style.css     light and dark, mobile first
    config.js     which Supabase project to talk to (public values only)
    supabase/     schema.sql, verify.sql, SETUP.md

`app.js` is in sections marked with `═══` comments, in the order: helpers,
months, data + sync, arithmetic, spreadsheet reading, import, screens,
export, settings, start. Keep new code in the section it belongs to.

## Invariants

These are the things that must not quietly break.

- **`Sales = Traffic × Conversion × UPT × ASP`** and **`SOT = Sales ÷
  Traffic`.** All six targets are entered, and the app flags rows where the
  arithmetic does not hold rather than deriving one from the others.
- **Conversion is a rate, never percentage points**: 0.075, not 7.5. Above
  100% is real and must be kept — a store whose counter under-reports sells
  to more people than it counted. Which unit a bare number is in is decided
  per row by the identity above, never by a threshold.
- **`storeId` is fixed forever.** Power BI joins on it. It cannot be retyped
  once a store exists.
- **Brand and channel are different questions.** Brand is the name over the
  door (Multi, Asics, Under Armour, Levis, Nike); channel is how the store
  trades (Retail, Outlet, Concession, Franchise, Ecommerce, Pop-up). Never
  collapse them.
- **Months are calendar months**, stored as `YYYY-MM` locally and a real
  first-of-month `date` in Postgres.
- **Targets are operational**, set at the end of each month and not revised.
  Strategic targets are a separate module that does not exist yet.
- Actuals are **not** here. They come from the POS into Power BI and join on
  `store_id` + `month_start`.

## Local-first, then sync

Every screen reads and writes `localStorage` synchronously through `Data`.
Sync is a separate errand: pull, merge by last-write-wins on `updatedAt`,
push back whatever is newer here. Deletions leave tombstones so the merge is
order-independent.

Consequences worth remembering:

- Every local write goes through `saved()`, which is the one place that
  knows a change also has to reach the server.
- Stores are pushed before targets (foreign key), but **independently** — a
  refused store must not strand the targets. That bug cost a day.
- Anything the server has not accepted is counted in Settings. The app and
  the database must never quietly disagree.

## Importing

The importer is deliberately forgiving about how a file is written and
deliberately strict about what it means:

- Headers match English first, Russian as a fallback, plus common
  misspellings. An unrecognised header is **reported as ignored**, never
  guessed at.
- Dates are read day-first: `01.08.2026`, `01/08/2026`, `2026-08-01`.
- `-`, `–`, `—`, `n/a`, `нет` are empty cells, not broken numbers.
- A value outside a closed vocabulary (channel, brand) is left blank and
  counted — never written through, because the database will refuse it and
  the error would surface far from the cause.
- A store name next to a store ID is a **check on it**, not decoration.
- Nothing is written until the preview has been seen and Apply pressed.

## Rules of the repo

- **Bump the version in one commit**: `VERSION` in `app.js`, all three `?v=`
  in `index.html`, and `version.json`. `test_version.js` fails otherwise.
  The `?v=` is what makes browsers fetch the new files.
- **`schema.sql` is idempotent and is the upgrade path.** There are no
  separate migration files. `create table if not exists` does nothing to an
  existing table, so every constraint is dropped by name and re-added on
  each run. Anything else silently fails to reach a live database.
- **Never commit** the database password or an `sb_secret_` /
  `service_role` key. The publishable key in `config.js` is public by
  design; row-level security and disabled self-signup are the protection.
- `storeManager` holds a name only. No emails, no phone numbers.

## Tests

    node test_logic.js      # no browser needed
    node test_browser.js    # Playwright + Chromium, skips itself if absent
    node test_version.js

`test_browser.js` drives the real app against real `.xlsx` fixtures, and
stubs Supabase at `window.fetch` — the seam the app talks through — so the
merge, the push selection, the row shapes and the error messages are all
real code.

**A test that passes with the fix removed is worth nothing.** Two in this
repo did before being rewritten. When fixing a bug, revert the fix and watch
the new test fail before committing it.

For anything touching `schema.sql`, run it against a real PostgreSQL on
three paths — fresh install, upgrade of a database holding data, and a
re-run — before shipping. That has caught four bugs a fresh install never
would have shown.

## The database

Supabase project `retail-ops`, ref `pkothyzdactdfxfubnkk`, eu-central-1.
Power BI connects through the **Session pooler** (IPv4); the direct
connection is IPv6-only and will not work. Point Power BI at the
`targets_report` view, not the raw tables.

`supabase/verify.sql` checks an install is sound and writes nothing it does
not delete again. Run it after any schema change.
