# RetailOS — change log

Newest first. Reconstructed from `git log` on 2026-08-31, which is the one
record that spans every session — cloud and local — that has touched this
repo, so it stands in for "check other chats" here: the actual cloud-session
transcripts (linked from several commits below as `Claude-Session:` URLs)
sit behind claude.ai login and aren't fetchable from this machine, but the
commit bodies already carry the reasoning, not just the diff.

**Keep this current**: add an entry whenever you commit a real change,
newest on top, before you push. A one-paragraph *why*, not a diff — the diff
is in git. See `CLAUDE.md` for the rest of the repo's rules.

---

## v14 — 2026-08-28 — Sidebar nav, faceted store list, Active/Inactive grouping
First of four passes putting the v13 mockup's actual *layout* back, not just
its colours. Fixed a one-line sidebar bug (`.tab`'s mobile `flex: 1 0 auto`
was never reset on desktop, so four nav buttons split the sidebar's full
height instead of sitting at their natural size). Stores became a table with
a filter rail (counts by status/channel/brand), group-by and sort-by
controls, and an Active section with a collapsed Inactive one underneath.
Narrow screens keep store/brand/status and drop the rest. Browser tests
follow the new markup (`.store-row`, not `.card`; rows addressed by name,
not `nth=0`).

## v13 — 2026-08-27 — Sidebar shell, list-style stores, settings cards
Restructured the four screens around a left sidebar nav on desktop (≥900px),
ERPNext-shell-inspired, as a no-op wrapper on mobile — no element IDs or
tab-switching logic touched, so nothing downstream broke. Store cards got
brand/channel badges and a status dot instead of one joined text line.
Settings became a card grid instead of one long scroll. Five new CSS tokens
for both light and dark.

## Round SOT to whole numbers — 2026-08-27 (v12)
SOT display changed from 2 decimal places to 0 (`dp: 0`), matching how
Sales and Traffic already display. Display-only: stored precision, the
SOT-vs-implied consistency check, and the CSV export are unchanged.

## One refused table must not strand the other, and say what is stranded — 2026-08-27 (v11)
The stores push and the targets push were chained with `.then`, so a store
the database refused (e.g. a channel value outside its vocabulary) silently
took every target down with it — the app kept showing months the database
had never received, with nothing on screen explaining why. Stores and
targets are now pushed independently (stores still first, since a target
needs the store to exist), each failure is caught without blocking the
other, and Settings now counts what this device holds that the server
hasn't accepted, with the sync badge reading "Sync failed" while anything is
outstanding.

## Do not write a channel or brand the database will refuse — 2026-08-27 (v10)
`buildStoreRows` fell back to the raw text (`matchChannel(raw) || cleanText(raw)`)
when a value didn't match the channel vocabulary, so an out-of-vocabulary
value sailed through the import preview looking fine and only failed later
as a bare constraint-violation error naming neither the row nor the column.
Unrecognised channel/brand values are now left blank and counted in the
preview instead, the same way an unreadable target cell already was.

## Stop a threshold deciding what a conversion means — 2026-08-27 (v9)
Three bugs found in one real 1,395-row target file:
- `-`, `–`, `—`, `n/a`, `нет` were reported as broken numbers rather than
  read as empty cells (17 rows wrongly held back).
- Conversion above 1 was unconditionally divided by 100. Four real rows held
  genuine rates above 100% (a store whose footfall counter under-reports
  sells to more people than it counted); dividing them by 100 silently
  corrupted them by a factor of a hundred. The unit is now decided per row
  by whether it reproduces `Sales = Traffic × Conversion × UPT × ASP`, and
  only falls back to the old assumption when a row has nothing to check
  against — the database's ceiling on conversion moved from 1 to 10 to
  match, and existing databases are migrated by constraint name.
- The same store-month appearing twice in one file was silently collapsed
  to whichever row came last; it's now reported instead.

## Use the store name to check the store ID, not just decorate it — 2026-08-27 (v8)
A store name sitting next to a store ID in a targets file is now a real
cross-check, not decoration the importer discarded: a mismatch holds the row
back and the preview names which store that ID actually is. A row carrying
only a name now stands in for the ID as long as the name is unique in the
store list; two stores sharing a name is refused rather than guessed.

## Do not drop a sync for a write that lands mid-round — 2026-08-27 (v7)
`schedule()` returned early while a sync round was already in flight and
never revisited it, so a write landing mid-round (e.g. two imports applied
back to back) was lost until something unrelated happened to trigger another
sync. It's now remembered and a further round runs when the current one
ends, including after a failed round.

## Read Russian headers as a fallback behind the English ones — 2026-08-26 (v6)
`normHeader` kept only `[a-z0-9]`, so every Cyrillic header normalised to an
empty string and could never match — which also broke searching stores by a
Russian name (it normalised to nothing and matched *every* store). Fixed to
keep letters from any script, and added Russian header/value synonyms
(Продажи, Трафик, Код магазина, Найк → Nike, Розница → Retail, …).
`Средний чек` deliberately excluded from the ASP synonyms — it's the average
transaction value (ASP × UPT), about half again too big, and mapping it
would create a false consistency-check failure.

## Read day-first dates, and a misspelt traffic header — 2026-08-26 (v5)
A real targets file wouldn't import: `01.08.2026` and `01/08/2026` had no
matching case in the month parser (it knew year-first and month-year, not a
full day-first date). Added, day-first unless the numbers rule it out past
the 12th. Also added `trafic` to the traffic header synonyms — it was being
silently ignored, so traffic targets would have imported blank.

## Separate a store's brand from its channel — 2026-08-26 (v4)
`store_brand` (Multi, Asics, Under Armour, Levis, Nike — the name over the
door) is now its own column and vocabulary, distinct from `store_channel`
(Retail, Outlet, Concession, Franchise, Ecommerce, Pop-up — how it trades).
Putting brand values into channel would have lost the retail/outlet/
concession distinction, and "how are outlets doing across brands" is an
early question for a multi-brand operator. Importer tidies common spellings
(Levi's / Levi Strauss → Levis, UA / Under Armor → Under Armour); an
unrecognised brand is left blank rather than guessed.

## Add address, latitude and longitude to stores — 2026-08-26 (v3)
Coordinates kept as text so given precision survives exactly, but range-
checked (-90..90 / -180..180) and carried through to `targets_report` for a
Power BI map. Found and fixed two schema upgrade-path bugs against a local
Postgres: column comments were running before the `alter table` that created
the columns (broke upgrades of an existing database), and `create or replace
view` can only append columns, so the view had to be dropped and recreated
rather than replaced in place.

## Sync with Supabase — 2026-08-26 (v2)
Signing in makes the same data available on the laptop, the phone, and in
Postgres for Power BI; signed out, nothing changes — the app still reads and
writes the browser copy synchronously. Sync pulls, merges by the same
last-write-wins rule the JSON backup restore already used, then pushes back
whatever is newer here — order-independent, so it doesn't matter which
device syncs first. Talks to PostgREST and Supabase Auth directly over
`fetch`, no SDK. Also this day: `config.js` (which project the app talks
to), `supabase/schema.sql` and `SETUP.md` (the database side, `targets_report`
view for Power BI, row-level security with anon revoked), `verify.sql` (an
install-sanity script that writes nothing it doesn't delete again), and
serving instructions (`file://` blocks the sync calls; `.nojekyll` for
Pages).

## Stores, monthly targets and Excel import — 2026-08-26 (v1)
First working slice. Store master data and operational targets by store by
calendar month, offline in one browser. The six targets are bound by
`Sales = Traffic × Conversion × UPT × ASP` (and `SOT = Sales ÷ Traffic`), so
all six are editable but a row where both sides of an identity disagree by
more than 1% is flagged rather than silently reconciled. Conversion stored
as a fraction, edited as percentage points. Import reads both real-world
layouts (one row per store-month, and months across the top) from a pasted
block or an `.xlsx`/`.csv` file, always previews the diff before writing,
and reads `.xlsx` without a library — it's a ZIP of XML and the browser can
inflate raw DEFLATE natively, so unzipping the four parts that matter and
parsing them with `DOMParser` is enough. Records carry `updatedAt` and
deletions leave tombstones, so restoring a backup merges order-independently
— the same rule sync would reuse later. CSV exports shaped for Power BI.
