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

`GET /healthz` shows how fresh the data is:
`{ ok, dataAsOf, live: { publishedAt, checkedAt, fresh, refreshing, error } }`.

## Connect an AI assistant

The server speaks MCP over HTTP ("Streamable HTTP") at `/mcp`, with no auth.

- **Claude Code**: `claude mcp add --transport http ohmigo http://127.0.0.1:3002/mcp`
- **Claude (web/desktop)**: Settings → Connectors → Add custom connector →
  the public `https://…/mcp` URL.
- **ChatGPT**: Settings → Apps & Connectors → developer mode → Create → the
  public `https://…/mcp` URL, no authentication.
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
| `NAP_STATUS_URL` | MOBI.E's `evActualStatus` | the live feed |

Secrets (`CEME_API_KEY`) go in the hosting platform's secret variables, never
in the repo.

## Deploy (Zerops)

`zerops.yml` describes one Node.js service with no database. The service needs:

- `HOST=0.0.0.0`, `PORT=3002`;
- `CEME_API_KEY`: the same value as ceme-v2's `CEME_API_KEY`. On ceme-v2, also
  set `CEME_API_KEY_RATE_LIMIT` (requests per minute for that key; see
  ceme-v2's `docs/04-api-auth.md`).

The readiness check is `/healthz`. Boot loads the dataset (a few seconds) and
answers before the live feed finishes downloading.

## Rate limiting

Not built in. Calls from ChatGPT and Claude come from their servers, not from
the user's device, so a per-IP limit would throttle all of a platform's users
as one. The expensive part is the ceme-v2 call, and it's cached (same kWh to
0.1 and same quarter-hour = same answer, for 5 minutes). Put Cloudflare in
front for DDoS protection; add per-client limits only if abuse shows up.
