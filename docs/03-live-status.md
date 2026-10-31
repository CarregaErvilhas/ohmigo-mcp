# 03 — Live status

"Is that charger free right now?" comes from the **NAP** dynamic feed
(`evActualStatus`). The code is `src/live.js`.

## The problem

The feed is **one XML file of ~38 MB** with the status of every charger in the
country. There's no compression, no way to ask for part of it, and no way to
ask for one charger. A download takes 13-30 seconds, and now and then the
connection drops halfway through.

We've asked for a chunked version. Until then, we live with the whole file.

## What we do

**On demand, with a cache.** Nothing is downloaded until a user asks a
question. Then:

1. If our copy is **less than 15 minutes old** (`LIVE_TTL_SECONDS`, ±10 %
   so instances drift apart), we use it, with no network at all. Why not
   fresher: every refresh is a full 38 MB download (see below), so a 5-minute
   TTL meant three times the traffic for a status that's best-effort anyway. Results carry
   `live.publishedAt`, so the assistant can say how old the status is.
2. Otherwise we start **one** download. If ten users ask at the same moment,
   they all share it (`refresh()` hands back the one already running).
3. If our copy is younger than **`LIVE_MAX_STALE_SECONDS`**, nobody waits for
   that download: the request answers at once with the copy it has, marked
   `fresh: false` and `refreshing: true`, and the download runs behind it. A
   status a bit old beats 25 seconds of silence, because a charger's
   status is best-effort anyway.
4. With no copy at all, or one older than that, the request waits, **at most
   25 seconds** (`LIVE_WAIT_SECONDS`). If the download takes longer, the
   request answers with what there is (the old copy, marked `fresh: false`,
   or no status), and the download keeps going for whoever asks next.
5. While it waits, the user sees "Getting live charger status from the NAP…"
   (in their language), if their chat app shows progress messages.

**So live data can be as old as `LIVE_MAX_STALE_SECONDS`**, and older while
the feed is down (see the backoff below). With a copy, the answer doesn't hide
it: when `live.fresh` is false, or the data was published well past the TTL
ago (`outdated`), the result carries a note with how many minutes ago it was
published, for the assistant to pass on, and so does the error when an old
status leaves no charger. It covers NAP prices as well as
status, and `available_only` and the choice among identical sockets went by
that status. The age counts from `publishedAt`, not from our last check,
because a publisher that has stalled keeps answering `304` and our copy looks
fresh. The flags and statuses
in one answer all come from the same copy: a tool takes a
`LiveStatus.snapshot()` once, so a refresh landing while it prices can't label
an answer built on the old copy as fresh.

**Cheap re-checks.** Every download sends the `ETag` of the copy we have
(`If-None-Match`). When the file hasn't changed, MOBI.E answers `304 Not
Modified` with no body. It still takes their server a few seconds, but we
don't download 38 MB again. In practice MOBI.E regenerates the file every
minute or two (the ETag and size change between checks), so a 304 is rare.
The feed has no gzip; asking MOBI.E to compress it would cut ~90 %.

**Streaming parse.** We read the XML as it arrives, piece by piece (with the
`saxes` parser), and keep only a small map: `"SITE/POINT" → { status, fees }`.
The 38 MB never sit in memory as one string. Parsing takes about 0.2 s; the
download is the slow part.

**One retry** when the download arrives cut short (the parser fails with an
"unclosed tag" error) or the connection resets. Other failures (an HTTP
error, a refused connection) are not retried at once: the next attempts back
off (`BACKOFF_MS` in `src/live.js`), and requests in between answer with the copy we
have instead of starting another download. `/healthz` shows `failures`,
`retryAt` and the size of the last download (`bytesLast`).

**One warm-up at boot**, so the first user after a deploy doesn't wait, a
random 0-20 s after start so two instances don't download together.

## Why not a poller?

A background job downloading the feed every few minutes would make every
answer instant. It would also pull ~38 MB twelve times an hour, all day,
mostly for nobody. While traffic is low, on demand is the better trade: the
first user after a spell longer than `LIVE_MAX_STALE_SECONDS` waits up to
~25 s, and after a shorter one gets an instant answer with an older status while the copy
refreshes for the next user.

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
