# Mood Journal 🌊

A simple, mobile-first mood journal webapp with a coastal beige + blue vibe.

Built by Ania (age 12) with help from Claude.

## Features

- Tap an emoji to log how you're feeling, multiple times a day
- Optional note + photo with each entry (camera or library)
- **Photo filters** — freckles, dog, smiley mouth, goofy gaze, bunny, cat,
  heart eyes, cool shades, blush, flower crown, sparkles and a disguise
- Calendar coloured by mood — six shades of blue + custom emojis
- Tap any day to see all your entries as chat bubbles with timestamps
- Daily inspirational quote
- Mood stats — most common feeling, bar chart, mood streak 🔥, photo streak 📷
- Custom emoji picker for any feeling that doesn't fit the six defaults
- Works offline and saves to your phone — an account is optional
- **Sign in with an emailed code** to sync across devices
- Export and restore your whole journal as one file

## How it works

`index.html` is the whole app — plain HTML, CSS and JavaScript, no frameworks
and no build step. Open it in a browser and it works.

### Where things are stored

| What | Where | Why |
|---|---|---|
| Entries (mood, note, time) | `localStorage` | Tiny — a few KB even after years |
| Photos | **IndexedDB**, as Blobs | Gigabytes available, and blobs are ~25% smaller than base64 |
| Photos (when signed in) | Supabase Storage, private bucket | Synced across devices |

Photos used to be base64 strings inside the same `localStorage` blob as
everything else. A compressed photo is ~200KB of base64 and iOS Safari caps
`localStorage` at 5MB, so from around the 24th photo onward every save threw
`QuotaExceededError`. The old code swallowed that error, so the app said
"✓ saved" while the entry vanished — and because it was always the newest days
that failed, both streaks read 0. Photos now live in IndexedDB and
`localStorage` only holds the small text index.

### Signing in

Sign-in emails an 8-digit code rather than a tappable link. On iOS a link
tapped in Mail opens Safari, and a home-screen PWA has its own separate
storage — so the session would land in the wrong place and the installed app
would still be signed out. A typed code lands wherever it's typed.

`api/send-login-link.js` (a Vercel function) mints the code with Supabase's
admin API and delivers it through Resend. The service key never reaches the
browser, and the code is never in the HTTP response — the only way to learn it
is to receive the email.

### Your data is yours

- Sync only ever **adds**. It never deletes a local entry, and signing out
  leaves everything on the device.
- Row-level security means one account can't see another's entries or photos,
  even holding a valid token for a different account.
- `⬇ export my journal` writes one self-contained JSON file with every entry
  and every photo embedded. `⬆ restore from a file` merges it back on any
  device, and running it twice won't duplicate anything.

## Setup

```bash
cp .env.example .env      # then fill it in
psql "$DATABASE_URL" -f supabase-schema.sql
psql "$DATABASE_URL" -f supabase-ratelimit.sql
```

Set `SUPABASE_PROJECT_URL`, `SUPABASE_SECRET_KEY` and `RESEND_API_KEY` in the
Vercel project too, so the sign-in function can reach them.

To reach addresses other than the Resend account owner's, verify a domain in
Resend and set `MAIL_FROM`. To close sign-up down to specific people, set
`ALLOWED_EMAILS`.

## Tech

Plain HTML, CSS, and JavaScript. No frameworks, no build step, no dependencies.
Supabase for auth, database and photo storage; Resend for email; Vercel for
hosting.
