# Hisaab

Everyone paid for something. Nobody agrees on what. Hisaab works it out and
clears the whole group in the fewest payments possible, exact to the last
paisa.

A shared-expense tracker for trips, built for the part everyone dreads: the
settling up.

---

## What it does

**Splits that add up.** Shares are worked out in paise and the odd remainder is
handed out one at a time, so ₹100 across three people is 33.34 + 33.33 + 33.33,
never ₹99.99. Amounts are stored as exact decimals end to end, never as floats.

**Uneven splits.** Three ate the biryani, two didn't. Enter the amounts by hand
and the app tells you how far off the total you are, and in which direction,
before it accepts them.

**Several payers on one bill.** Two people put money in at the counter. Record
both, and the ledger credits each of them.

**The fewest transfers.** Rather than everyone paying everyone, the whole trip
collapses into the shortest list of payments that clears the group.

**People change mid-trip.** Someone leaves early? Redistribute their share
across whoever remains, or keep the history exactly as recorded. Members are
retired rather than deleted, so their past payments stay in the ledger.

**Your data leaves with you.** Export a whole trip to CSV or Excel, with a row
per person per expense and a summary that reconciles.

**Works with no signal.** Everything runs in the browser and stays usable on a
bus, in a hill station, or on aeroplane mode. It installs to a phone home screen
and opens like an app.

---

## Roadmap

Native iOS and Android builds are planned, for the App Store and Google Play.
The web app implementation and will stay free.

---

## Tech stack

React 19 · TypeScript · Tailwind CSS · Supabase (Postgres, Auth) · SheetJS

---

## Getting started

```bash
git clone https://github.com/tanishhhk/expense-tracker.git
cd expense-tracker
npm install
npm start
```

The app runs fully without a backend. Trips are saved in the browser, and
sign-in is simply hidden when Supabase is not configured.

### Optional: cloud sync

Copy `.env.example` to `.env` and fill in the two values from your Supabase
project, under **Project Settings → API**:

```
REACT_APP_SUPABASE_URL=https://your-project.supabase.co
REACT_APP_SUPABASE_ANON_KEY=your-anon-public-key
```

Use the **anon public** key, never the `service_role` key. That one bypasses
every database rule. `.env` is gitignored.

Then apply the migrations in order, via the Supabase dashboard's SQL Editor:

| File | What it does |
|------|--------------|
| `supabase/migrations/0001_init.sql` | Tables and row level security |
| `supabase/migrations/0002_sync.sql` | Invariants, payments, row caps |
| `supabase/migrations/0003_write_path.sql` | `save_trip` / `delete_trip` |
| `supabase/migrations/0004_close_remaining_grants.sql` | Locks the tables to read-only |

Sign-in is a six digit code by email. No password to choose, forget, or reset.

---

## How data is stored

Local-first. The browser holds the working copy and the cloud is a mirror.

- **Signed out**, trips live in `localStorage` and never leave the device.
- **Signed in**, every change is written locally first and pushed in the
  background. Nothing in the interface waits on the network.
- Each account gets its own local store, so two people sharing a browser never
  see each other's trips, and signing out leaves the anonymous store untouched.
- Editing the same trip on two devices resolves by last write, compared using
  the server's timestamp rather than the client's.

The header always states where your data currently is, and changes when that
changes.

---

## Security

Row level security answers *may I touch this row?* It never answers *is this
row sane?* Both questions are handled in the database, so no client can skip
either.

- The five tables grant `select` and nothing else. All writes go through
  `save_trip` and `delete_trip`.
- Those functions re-derive ownership from `auth.uid()`. Any owner field in the
  payload is discarded, and writing into a trip you do not own raises.
- Splits and payments must sum to their expense's total, enforced by deferred
  constraint triggers so a whole trip is validated at commit.
- Composite foreign keys make a split referencing another trip's member
  structurally impossible.
- Amounts are bounded, and rows are capped per trip and per account.

`supabase/tests/hostile.sql` contains payloads a client could send but should
never succeed with. Run it after changing any migration: seven blocks must
fail, the eighth must succeed.

---

## Testing

```bash
npm test -- --watchAll=false     # unit tests
npx tsc --noEmit                 # types
npm run build                    # production build
```

The suite runs with Supabase disabled via `.env.test`, so it is deterministic
and makes no network calls. The arithmetic (allocation, settlement, member
removal, row translation, conflict resolution) is pure and tested directly.

---

## Project structure

```
src/
├── App.tsx           App shell, trip and expense screens, settlement
├── Landing.tsx       Marketing page
├── SignIn.tsx        Email code auth
├── supabase.ts       Client, deliberately nullable
└── sync/
    ├── ids.ts        uuid generation, legacy id migration, storage keys
    ├── rows.ts       Trip ⟷ database row translation
    ├── reconcile.ts  Merging local and remote copies
    ├── remote.ts     The only file that talks to Supabase
    └── useSync.ts    Debounce, retry, online/offline, status

supabase/
├── migrations/       Schema, applied in numeric order
└── tests/            Hostile-write checks
```

---

## Author

Tanishk Jain. [github.com/tanishhhk](https://github.com/tanishhhk)
