# ScaileAI content engine

Publishes scheduled Instagram posts without anyone present.

## How it works

`engine/queue.json` is the schedule. A GitHub Actions job runs hourly, works out
the current local time in the queue's timezone, and publishes anything whose slot
has arrived. It then writes the queue back so a post can never go out twice.

The job **never generates anything**. It only publishes posts that were rendered,
checked and hosted in advance. No image generation, no caption writing, no paid
API calls running unattended. That is the whole safety model: nothing improvises.

## The queue

```jsonc
{
  "timezone": "America/Denver",
  "posts": [
    {
      "id": "2026-08-27-am",
      "publishAt": "2026-08-27T06:50",   // local to the timezone above
      "slug": "while-you-were-working",  // matches the folder on the media host
      "type": "reel",                    // reel | image | carousel
      "slides": 7,                       // carousels only
      "status": "queued"                 // queued | posted | skipped
    }
  ]
}
```

Delete an entry to cancel a post. Change `publishAt` to move it. Nothing else is
required.

## Why hourly

Cron in GitHub Actions is UTC. Mountain time shifts an hour with daylight saving,
so a fixed UTC schedule would drift the posting time twice a year. Running hourly
and comparing local time inside the script is immune to that and needs no seasonal
maintenance.

A post more than 150 minutes past its slot is skipped rather than published late.
A "good morning" post landing at 4pm is worse than no post.

## Safety behaviour

- Every asset URL is checked before anything publishes. Unreachable media means
  the post is skipped and the run reports an error.
- A missing caption skips the post rather than publishing a bare image.
- A failed publish leaves the entry queued so a later run inside the grace window
  can retry.
- The queue is committed back after each run, so a post cannot publish twice.

## Secrets

Set in the repository under Settings, Secrets and variables, Actions:

| Secret | What it is |
|---|---|
| `IG_ACCESS_TOKEN` | Instagram Graph API token. Expires roughly every 60 days. |
| `IG_BASE_URL` | Where the media is hosted, e.g. `https://scaileaiinsta.netlify.app` |

## Running it by hand

Actions tab, "Publish scheduled posts", Run workflow. Tick the dry run box to see
what it would publish without publishing anything.

Locally:

```bash
node engine/run-publisher.mjs --dry-run
```

## Making the posts

Content is produced on a workstation, not here. `scripts/post.mjs` renders slides,
adds the logo, converts to JPEG, builds a reel where needed, deploys to the media
host and can publish immediately. The engine handles the scheduled path; that
script handles the manual one.

The brand system lives with the skill, in `~/.claude/skills/ig-carousel/`:
`brand.json` for the look, `brand-guide.md` for tone and strategy.
