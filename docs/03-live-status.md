# 03 — Live status

"Is that charger free right now?" comes from the **NAP** dynamic feed
(`evActualStatus`). The code is `src/live.js`.

## The problem

The feed is **one big XML file** (`bytesLast` in `/healthz` has its size) with the status of every charger in the
country. There's no compression, no way to ask for part of it, and no way to
ask for one charger. A download takes 13-30 seconds, and now and then the
connection drops halfway through.

We've asked for a chunked version. Until then, we live with the whole file.

## What we do

**On demand, with a cache.** Nothing is downloaded until a user asks a
question. Then:

1. If our copy is **less than 5 minutes old** (`LIVE_TTL_SECONDS`, ±10 %
   so instances drift apart), we use it, with no network at all. 5 minutes
   matches how often the NAP publishes (about every 5 minutes). Every refresh is a full
   download (see below), but only while someone is asking: with no users,
   there is no traffic. Results carry
   `live.publishedAt`, so the assistant can say how old the status is.
2. Otherwise we start **one** download. If ten users ask at the same moment,
   they all wait on that same download (`refresh()` hands back the one
   already running).
3. A request waits **at most 25 seconds** (`LIVE_WAIT_SECONDS`). If the
   download takes longer, the request answers with the previous copy (marked
   `fresh: false`), or with no status if there's no copy yet. The download
   keeps going for whoever asks next.
4. While it waits, the user sees "Getting live charger status from the NAP…"
   (in their language), if their chat app shows progress messages.

**Cheap re-checks.** Every download sends the `ETag` of the copy we have
(`If-None-Match`). When the file hasn't changed, MOBI.E answers `304 Not
Modified` with no body. It still takes their server a few seconds, but we
don't download the file again. In practice MOBI.E regenerates the file every
minute or two (the ETag and size change between checks), so a 304 is rare.
The feed has no gzip; asking MOBI.E to compress it would cut ~90 %.

**Streaming parse.** We read the XML as it arrives, piece by piece (with the
`saxes` parser), and keep only a small map: `"SITE/POINT" → { status, fees }`.
The file never sits in memory as one string. Parsing takes about 0.2 s; the
download is the slow part.

**One retry** when the download arrives cut short (the parser fails with an
"unclosed tag" error) or the connection resets. Other failures (an HTTP
error, a refused connection) are not retried at once: the next attempts back
off (`BACKOFF_MS` in `src/live.js`), and requests in between answer with the copy we
have instead of starting another download. `/healthz` (with its token, see [06](06-run-and-deploy.md)) shows `failures`,
`retryAt` and the size of the last download (`bytesLast`).

**One warm-up at boot**, so the first user after a deploy doesn't wait, a
random 0-20 s after start so two instances don't download together.

## Why not a poller?

A background job downloading the feed every few minutes would make every
answer instant. It would also pull the whole file twelve times an hour, all day,
mostly for nobody. While traffic is low, on demand is the better trade: the
first user after a quiet spell waits up to ~25 s, and everyone in the next 5
minutes gets an instant answer.

If traffic grows, add a poller back (a `setInterval(() => live.refresh(), ...)`
in `server.js`). Nothing else needs to change.

## Gotcha: point ids aren't unique

Some operators publish bare numbers as charger ids ("19", "160"), and the same
number shows up on several sites. So the key is always the site id plus the
point id, written `SITE/POINT`. Every tool returns and accepts ids in that
form.

## Status values

| NAP value | Meaning | Kept when `available_only` is on? |
|---|---|---|
| `available` | free | yes |
| `unknown` | the operator doesn't say | yes (a lot of the network reports this) |
| `charging` | in use | no |
| `outOfOrder`, `inoperative` | broken | no |
| `blocked` | blocked | no |
| `planned` | not built yet | no |
