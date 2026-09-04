# Sharing Folio with other people

Written 4 September 2026, from what the code actually is today rather than what
a checklist template says a "production app" needs.

## The short answer to "we need Firebase and Google login, right?"

**Probably not, and not first.** Login exists to answer one of two questions:

1. *Who is this, so I know whose data to sync?*
2. *Who is this, so I can cap what they cost me?*

If people bring their own API keys and keep their own data in their own browser,
neither question arises and an account is pure overhead — a signup wall in front
of an app that would otherwise just work.

The thing that will actually hurt the people you share this with is **not the
absence of a login**. It is that their notes live in one browser and can vanish.

## What Folio is today

| | |
|---|---|
| Hosting | Static files on Vercel. No backend, no server code, no database. |
| Accounts | None. There is no auth of any kind in the codebase. |
| Data | `localStorage`, one browser, one device. `exportAll`/`importAll` exist for manual backup. |
| AI keys | **Three**, supplied by each user: Gemini, Groq, Speechify. |
| Desktop | An unsigned macOS Electron app. |
| Cost to run | **Zero.** Vercel static hosting, and every user pays their own AI bill. |

That last row is worth pausing on. Folio currently costs you nothing per user,
however many there are. Any design that routes AI through your keys ends that,
and everything else — auth, rate limits, a database — follows from it.

## What breaks the moment someone else opens it

Walked through as a first-time user, in order:

| # | What they do | What happens now |
|---|---|---|
| 1 | Open the URL | An empty app with no guidance. Nothing explains that three API keys are needed. |
| 2 | Write a note | Works. |
| 3 | Press play to read aloud | The 2009 system voice, unless they sign up for Speechify. |
| 4 | Dictate a comment | Nothing, until they get a Groq key. |
| 5 | **Paste a YouTube link** | **Cannot work.** Transcription needs a Gemini key *and* `yt-dlp` installed *and* `node helper/folio-helper.js` running on port 8787. No ordinary person will do this. |
| 6 | Return next week | Their data may be gone — Safari clears best-effort storage after ~7 days. *(Now mitigated: durable storage is requested at startup.)* |
| 7 | Open it on their phone | Empty. Nothing syncs. |
| 8 | Send a page to a friend | Impossible. |
| 9 | Download the Mac app | Gatekeeper refuses to open an unsigned app. |

Rows 5 and 9 are the two that make Folio look broken rather than limited. Row 6
was the dangerous one and is fixed. Rows 7 and 8 are the ones that need a
backend — and only if people actually want them.

## The decision everything else hangs off

**Who pays for the AI?**

### Option A — they bring their own keys (what exists)

- Costs you **nothing**, at any number of users.
- No backend, no auth, no database, no Firebase.
- Price: three signups before the app is fully useful. Fine for technical
  friends, hopeless for anyone else.

### Option B — you proxy the AI through your keys

- Now you are paying. Speechify is $6 per million characters: one enthusiastic
  reader getting through a book is a few dollars, and ten unsupervised users is
  real money with no ceiling.
- **This is the only reason to add login.** You need to know who is calling in
  order to cap them, which means auth, per-user quotas, a backend to hold the
  keys, and somewhere to record usage.
- Also inherits Speechify's **one concurrent request per plan** — proxied, your
  users queue behind each other. That needs a plan upgrade before it is shared
  with more than one person reading at a time.

### Option C — accounts and sync, keys still theirs

- Solves the real problems (rows 6, 7, 8) without taking on the AI bill.
- Auth + a document store. Firebase or Supabase are both reasonable.
- The middle path, and the one to reach for **when somebody actually asks for
  sync** rather than in anticipation.

## Recommendation

**Share it as Option A first, and fix what makes it look broken.** Concretely:

1. **An onboarding that explains the keys** — what each one unlocks, what it
   costs, where to get it, and that the app is useful without any of them.
2. **Gate the video feature honestly.** It cannot work without a local helper,
   so it should say so up front rather than failing at the end of a long wait.
3. **Make backup obvious.** `exportAll` exists but is buried in Settings.
   Anyone relying on this should be reminded, and told plainly that their data
   is in this browser only.
4. **Sign the Mac app**, if you are distributing it at all.

Then add Option C when someone asks for sync, and Option B only if you decide to
absorb the AI cost deliberately.

**None of steps 1-3 need a human.** Step 4 does, and so does the one urgent item
below.

## Urgent, regardless of which path

**Three API keys have been pasted into a chat transcript** — Gemini, Groq and
Speechify. They should be rotated before anything is shared, and the new ones
never leave your own machine. This is the single most time-sensitive item here,
and it is GUI-only.
