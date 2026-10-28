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

`GET /` is the landing page for people (`site/index.html`): what ohmigo is
and how to add it to each assistant. It's one static file, read once at boot,
so restart the server to see edits. It picks Portuguese or English from the
browser (a `?lang=pt|en` link or the flag buttons override it), and its
sentences live in the `#strings` block at the bottom, both languages with the
same keys (`test/site.test.js` checks). A browser that opens `/mcp` is sent to
`/#instalar`, since people paste the address there by mistake; MCP clients
never ask for HTML, so they're unaffected.

`GET /healthz` shows how fresh the data is:
`{ ok, dataAsOf, live: { publishedAt, checkedAt, fresh, refreshing, error } }`.

## Connect an AI assistant

The server speaks MCP over HTTP ("Streamable HTTP") at `/mcp`, with no auth.

- **Claude Code**: `claude mcp add --transport http ohmigo http://127.0.0.1:3002/mcp`
- **Claude (web/desktop)**: Settings → Connectors → Add custom connector →
  `https://ohmigo.ocarroeletrico.com/mcp`.
- **ChatGPT**: Settings → Apps & Connectors → developer mode → Create →
  `https://ohmigo.ocarroeletrico.com/mcp`, no authentication.
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
| `LIVE_TTL_SECONDS` | `300` | how long a live feed copy counts as fresh |
| `LIVE_WAIT_SECONDS` | `25` | how long a request waits for a live download |
| `LIVE_WARMUP` | on | `0` skips the boot download |
| `OHMIGO_QA` | off | `1` turns on QA mode: every result carries the quarter-hour `timeline` and a `debug` block, and the assistant is told to show them. Never in production |
| `NAP_STATUS_URL` | MOBI.E's `evActualStatus` | the live feed |

Secrets (`CEME_API_KEY`) go in the hosting platform's secret variables, never
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

The readiness check is `/healthz`. Boot loads the dataset (a few seconds) and
answers before the live feed finishes downloading.

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
0.1 and same quarter-hour = same answer, for 5 minutes). Put Cloudflare in
front for DDoS protection; add per-client limits only if abuse shows up.
