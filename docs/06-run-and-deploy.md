# 06 — Run, connect, deploy

## Run it locally

You need Node.js 24.

```bash
npm ci
npm test
npm start                 # http://127.0.0.1:3002/mcp
```

Without `data/chargers.json` the server downloads the dataset from Pages
([05](05-dataset.md)). On boot it also starts one download of the live NAP
feed, which takes ~20 s; requests made during that time wait for it.

Call a tool from the terminal:

```bash
node scripts/call.mjs find_cheapest_charging '{"place":"Leiria","battery_kwh":58,"start_pct":20,"lang":"pt"}'
```

Progress messages go to stderr, the JSON result to stdout.

`GET /` is the landing page for people, in Portuguese, and `GET /en` the same
page in English: what ohmigo is and how to add it to each assistant.
`src/site.js` renders `site/index.html` once at boot, one copy per language with
the text already in the HTML, so restart the server to see edits. The language
comes from the URL, not from the browser, and an old `?lang=` link redirects to
the right URL. The flag links go to the other URL; on `/` a browser that picked
English before is sent to `/en` (the page's script, `localStorage`). The
sentences live in the `#strings` block at the bottom, both languages with the
same keys (`test/site.test.js` checks). A browser that opens `/mcp` is sent to
`/#instalar`, since people paste the address there by mistake; MCP clients
never ask for HTML, so they're unaffected.

`GET /privacidade` and `GET /suporte` are the privacy and support pages that the
assistants' directories ask for, in Portuguese; `GET /privacy` and
`GET /support` are their English copies. They work the same way: one source,
`site/legal.html`, with the same two-language strings block and parity test, and
`src/site.js` renders one copy per URL at boot (`LEGAL` lists each page's
sections). These pages send no script, and their CSP says so: the language
buttons are plain links, an old `?lang=` link redirects too, and the links home
carry `?lang=` so the landing page's script saves the language being read. If
the server starts keeping or sending
anything new about the user, update the privacy page first.

`GET /.well-known/security.txt` is the RFC 9116 file with the contact for
reporting a security problem. It's generated per request (`securityTxt` in
`src/server.js`), so `Expires` is always ahead of today.

`GET /healthz` shows how the server is doing: `status` is `ok`, or
`degraded` with the reasons in `problems` (the last live feed refresh failed,
ceme-v2 isn't answering, the dataset missed its weekly rebuild). It answers 200
either way, so the platform doesn't restart a container over an outage
elsewhere; point a monitor at `status`. Anyone can read that summary, plus
`version`, `dataAsOf` and `dataAgeHours`; `problems` names what's wrong, never
the raw error. Send the `x-healthz-token` header with the value of
`HEALTHZ_TOKEN` and the same answer adds the live feed (`publishedAt`, `fresh`,
`failures`, `retryAt`, `bytesLast`, the last `error`), the ceme-v2 breaker,
per-tool counters (`calls`, `errors`, `avgMs`, `maxMs`, `maxBytes`) and memory:

```bash
curl -H "x-healthz-token: $HEALTHZ_TOKEN" http://127.0.0.1:3002/healthz
```

With `HEALTHZ_TOKEN` unset, nobody gets the detail. A wrong token isn't an
error: you get the summary and a 200.

Every tool call logs one JSON line (`tool`, `ms`, `isError`, `code`,
`bytes`). Never the arguments: they carry the user's location, car and
tariffs. Results carry `version`, to match a report with a deploy.

## Connect an AI assistant

The server speaks MCP over HTTP ("Streamable HTTP") at `/mcp`, with no auth.

- **Claude Code**: `claude mcp add --transport http ohmigo http://127.0.0.1:3002/mcp`
- **Claude (web/desktop)**: Settings → Connectors → Add custom connector →
  `https://ohmigo.ocarroeletrico.com/mcp`.
- **ChatGPT** (browser, desktop or mobile — not the mobile app): left
  sidebar → Plugins → Add (top right) → Custom → name it, paste
  `https://ohmigo.ocarroeletrico.com/mcp`, switch authentication to
  "No authentication", tick the trust box, and create.
- **MCP Inspector**, for poking at it: `npx @modelcontextprotocol/inspector`,
  then connect to the URL.

Chat apps need a public HTTPS URL, so they only work once it's deployed.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` / `HOST` | `3002` / `127.0.0.1` | where to listen; Zerops needs `HOST=0.0.0.0` |
| `CEME_API_URL` | `https://ceme.ocarroeletrico.com` | ceme-v2 |
| `CEME_API_KEY` | none | ceme-v2 API key. Without it, the server borrows an anonymous web session, rate-limited to 60 requests/min per IP: fine for development, not for production. |
| `DATASET_PATH` | none | read the dataset from this file |
| `DATASET_URL` | the Pages URL | read the dataset from this URL |
| `DATASET_CHECK_HOURS` | `6` | how often to check for a new dataset |
| `LIVE_TTL_SECONDS` | `300` | how long a live feed copy counts as fresh (±10 %) |
| `LIVE_WAIT_SECONDS` | `25` | how long a request waits for a live download |
| `LIVE_WARMUP` | on | `0` skips the boot download |
| `HEALTHZ_TOKEN` | none | unlocks the detail on `/healthz`, sent in the `x-healthz-token` header. Without it the detail stays private. |
| `OHMIGO_QA` | off | `1` turns on QA mode: every result carries the quarter-hour `timeline` and a `debug` block, and the assistant is told to show them. Never in production |
| `NAP_STATUS_URL` | MOBI.E's `evActualStatus` | the live feed |

Secrets (`CEME_API_KEY`, `HEALTHZ_TOKEN`) go in the hosting platform's secret variables, never
in the repo.

## Deploy (Zerops + Cloudflare)

```
assistant ──► Cloudflare (proxy, TLS) ──► Zerops L7 balancer ──► service `mcp` (Node.js)
```

Production is `https://ohmigo.ocarroeletrico.com/mcp`, Zerops project
`ohmigo-mcp`, one service called `mcp`.

- **`zerops.yml`** is the build and runtime: `deployFiles` lists what ships
  (`src`, `ui`, `site`, `offers`, `node_modules`, `package.json`). Anything the code
  reads at runtime must be in that list, or the process dies on boot and the
  deploy fails with "connection refused" on `/healthz`.
- **`zerops-import.yaml`** creates the service (`zcli project service-import`).
  It sets `HOST=0.0.0.0` and `PORT=3002`.
- `CEME_API_KEY`: the same value as ceme-v2's `CEME_API_KEY`. On ceme-v2, also
  set `CEME_API_KEY_RATE_LIMIT` (requests per minute for that key; see
  ceme-v2's `docs/04-api-auth.md`). A secret: set it on the service in the
  Zerops console.
- `HEALTHZ_TOKEN`: a long random value (`openssl rand -hex 32`), also a secret.
  A monitor only needs it to read `live`, `ceme`, `tools` or `memoryMb`.

The readiness check is `/healthz`, which only needs the 200 of the summary. Boot loads the dataset (a few seconds) and
answers before the live feed finishes downloading. If the dataset download
fails, boot retries for a while, inside the readiness timeout
(`loadDataset` in `src/server.js`; keep the two in step), then exits, so the
previous version keeps serving. On `SIGTERM` (a deploy), the server stops
taking connections and lets the requests in flight finish, with a cap.

### Shipping a new version

Open a pull request into `main` and merge it (direct pushes are blocked by
the `main` ruleset, and the `test` check must pass). Zerops is connected to this repo (service `mcp` → Build,
Deploy, Run Pipeline Settings: push to `main`, setup `mcp`) and builds and
deploys on every merge, in about two minutes. No Zerops credential lives in
GitHub. A deploy that fails its readiness check is dropped and the previous
version keeps serving.

By hand, only as a last resort, from a clean copy of `main`:

```bash
git archive main | tar -x -C /some/empty/dir
cd /some/empty/dir && zcli push <service-id> -P <project-id> --setup mcp --no-git
```

### Domain and DNS

The same setup as ceme-v2 (its `infra.md`, section 3, has the API calls):

1. Zerops: a public HTTP routing for `ohmigo.ocarroeletrico.com` → `mcp`
   port 3002, with SSL, then sync the project's routing.
2. Cloudflare: **one `AAAA` record** to the project's dedicated IPv6, **proxy
   on**. No `A` record: the shared IPv4 can't route a proxied domain.
3. Zerops: trigger the DNS check; the Let's Encrypt certificate follows.

**The origin IP is never written in this repo.** Read it from the Zerops
API (`GET /project/<id>` → `publicIpV6`) or the Cloudflare record.

The routing's `accessPolicy` only accepts Cloudflare: `defaultPolicy: deny`,
`cidr` = the lists at `https://www.cloudflare.com/ips-v4` and `ips-v6`.
Leave **`setRealIpFrom` empty**: with it set, the balancer swaps in the
user's IP from `X-Forwarded-For`, that IP isn't Cloudflare's, and every
request gets 403. Direct requests to the origin must answer 403; through
Cloudflare, 200.

## Rate limiting

Not built in. Calls from ChatGPT and Claude come from their servers, not from
the user's device, so a per-IP limit would throttle all of a platform's users
as one. The expensive part is the ceme-v2 call, and it's cached (same kWh to
0.1 and same quarter-hour = same answer, for 5 minutes); after a few failures in
a row the client stops calling for a while (`BREAKER_*` in `src/ceme.js`)
and the tools answer without CEME prices. A ranking quotes a capped number
of plugs, nearest first (`MAX_RANKED_POINTS` in `src/mcp.js`). Put Cloudflare in
front for DDoS protection; add per-client limits only if abuse shows up.
