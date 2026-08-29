# Making the publisher actually run on time

## Why this exists

GitHub Actions treats a `schedule:` entry as *permission* to run, not a promise.
When its queues are busy it skips runs, and it skips a lot of them. Measured on
this repo over roughly 50 hours: **6 scheduled runs where ~50 were expected.**

Twice on 28 August 2026 a run landed shortly *before* a posting slot, correctly
found nothing due, and then no further run came for hours:

| Slot     | Last run before it | Next run   | Outcome            |
|----------|--------------------|------------|--------------------|
| 06:50    | 05:25              | none       | published by hand at 09:38 |
| 16:40    | 16:22              | none       | published by hand at 18:39 |

The publisher is not at fault — every run in the history succeeded. Nothing was
waking it up.

## The fix

`workflow_dispatch` — the "Run workflow" button — also has an API address.
A free external cron service calls it every 15 minutes. GitHub treats that as a
manual press, and manual presses are **not** throttled the way schedules are.

The built-in `schedule:` stays in place as a backstop. Two independent triggers,
either of which is sufficient.

Double-publishing is not a risk: `publish.yml` sets `concurrency: group: publish`
with `cancel-in-progress: false`, so overlapping triggers queue rather than run
together, and the second one checks out a queue in which the first already
marked the post `posted`.

## Part 1 — the GitHub token

A narrow credential that can do exactly one thing: start workflows in this one
repository. It cannot read code, push, or touch any other repo.

1. Go to https://github.com/settings/personal-access-tokens/new
2. **Token name:** `cron-job-publisher`
3. **Resource owner:** `ScaileAI` — not the personal account. The repo belongs to
   the org, and picking the wrong owner here is the most common way this fails.
   If the org has approval required for tokens, the request will sit pending
   until an org owner approves it.
4. **Expiration:** 1 year (the maximum). Put the date in the calendar — when it
   lapses, posting silently stops again.
5. **Repository access:** *Only select repositories* -> `scaileai-content-engine`
6. **Permissions** -> *Repository permissions* -> **Actions: Read and write**
   (Metadata: Read-only is added automatically. Nothing else is needed.)
7. Generate, and copy the token. It is shown once.

If fine-grained tokens are blocked at the org level, a classic token with the
`workflow` scope also works, but it is broader — prefer fine-grained.

## Part 2 — the cron service

1. Sign up free at https://cron-job.org
2. Create cronjob.
3. **Title:** `ScaileAI publisher`
4. **URL:**
   ```
   https://api.github.com/repos/ScaileAI/scaileai-content-engine/actions/workflows/publish.yml/dispatches
   ```
5. **Schedule:** every 15 minutes — minutes 5, 20, 35, 50 of every hour.
   A post then goes out within 15 minutes of its slot. Hourly also works and
   makes less noise in the Actions log, at the cost of punctuality.
   This repo is public, so GitHub Actions minutes are free either way.
6. **Advanced / request settings:**
   - **Request method:** `POST`
   - **Headers:**
     ```
     Accept: application/vnd.github+json
     Authorization: Bearer YOUR_TOKEN_HERE
     X-GitHub-Api-Version: 2022-11-28
     Content-Type: application/json
     ```
   - **Body:**
     ```json
     {"ref":"main"}
     ```
7. Turn on **notification on failure**. This is how an expired token announces
   itself instead of just quietly stopping the posts.
8. Save, then press **Run now**.

## Confirming it worked

A success is **HTTP 204 No Content** — an empty response, not an error. GitHub
returns nothing at all when it accepts a dispatch.

Then check https://github.com/ScaileAI/scaileai-content-engine/actions — a new
run with the event `workflow_dispatch` should appear within seconds.

## When it breaks

- **401** — token wrong, expired, or missing the `Bearer ` prefix.
- **403** — token lacks *Actions: Read and write*, or the org has not approved it.
- **404** — wrong resource owner on the token, or the repo path is mistyped.
  GitHub returns 404 rather than 403 for repos a token cannot see.
- **422** — the `ref` does not exist. The branch is `main`.
