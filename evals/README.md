# Evals

`npm test` checks the server: given these arguments, this answer. It can't
check the other half: given what a user writes, does an assistant pick the
right tool, pass the right arguments and present the result honestly? That
half depends on the words in `src/mcp.js` (instructions, tool and argument
descriptions) and in the results (`assumptions`, `notes`, from `src/i18n.js`),
and a model reading them. These evals put a model in front of them.

Run them when you change any of that, and before you merge. They aren't in CI
(they need a model to run); in Claude Code, the `ohmigo-evals` skill
(`.claude/skills/ohmigo-evals/SKILL.md`) drives a whole run with Haiku
sub-agents.

## How a run works

```
 evals/serve.mjs ── starts ohmigo (this checkout, or --ref main in a worktree)
   │                 writes evals/runs/<run>/<case>/brief.md for every case
   ▼
 one sub-agent per case reads its brief: the user's message, what the app
   │  remembers, the server's instructions and tool list, as a chat app shows them
   │  calls tools:  node evals/call.mjs <case dir> <tool> '<json>'   (logged)
   │  writes its reply to <case dir>/answer.md
   ▼
 evals/grade.mjs ── checks the calls and the answer against cases.json
   │                 writes judge.md for the questions that need a model
   ▼
 one judge sub-agent per judge.md ── writes judge.json (yes / no / n/a)
   ▼
 evals/grade.mjs again ── report.md; or two runs side by side
```

What the server works with:

- **Dataset**: a frozen copy of the public one in `evals/.cache/` (downloaded
  on the first run; `--refresh-data` takes this week's), so two runs compare on
  the same chargers.
- **CEME prices**: the real ceme-v2, like `npm start` (anonymous session, or
  `CEME_API_KEY` if you set it). Tariffs and campaigns change, which is why
  cases declare what they need (`requires`, below) and are skipped when it's
  gone.
- **Live status**: off (every socket "unknown"), the same on every run.
  `--live` fetches the NAP feed.

Variants (`--variant`) show the assistant the instructions whole (`full`), cut
at 4 096 characters like Claude Code does (`cut`), or not at all (`none`, like
a client that ignores them: then the tool descriptions have to carry it).

## A case

`cases.json`, one object per conversation:

| Field | What it is |
|---|---|
| `id` | Short name, also the case's directory |
| `why` | The rule it checks, for whoever reads a failure |
| `message` | What the user writes |
| `memory` | What the app remembers about the user (optional) |
| `requires` | What it needs that isn't frozen (optional): `{"site": "<id>"}` in the dataset; `{"tariff": "<name query>", "id": "<regex>", "audience": "<id>", "newCustomersOnly": true}` or `{"promo": "<target regex>", "newCustomers": true}` in ceme-v2 |
| `expect` | What a good assistant does (below) |

`message` and `memory` can say `{{month}}` and `{{year}}` (the current ones,
in Portuguese) instead of a date that would go stale.

`expect`:

- `calls`: each must be matched by at least one tool call;
- `noCalls`: none may match;
- `every`: every call (to `tool`, if given) must match, e.g. `lang`;
- `answer.match` / `answer.noMatch`: regexes on the reply (case-insensitive);
- `judge`: yes/no questions for a judge model, phrased so "yes" is right; a
  question can allow "n/a" ("Answer n/a if…") for things the data may not show.

A call expectation is `{"tool": "<regex>", "args": {…}, "ok": true}`. `tool`
matches the whole name (`"estimate_charging_cost|lookup_charger"`), `ok: true`
skips calls that came back as errors, and each argument is matched by:

| Matcher | Means |
|---|---|
| `true` / `false` | the argument is there / isn't |
| `[min, max]` | a number in that range |
| `"regex"` | the value (JSON, for arrays and objects) matches |
| `"*": "regex"` | all the arguments, as JSON, match: "place or lat/lon" |

Write cases about behaviour, never about prices or exact words: prices move
every week and a good answer can be phrased many ways. One rule per case, so a
failure says what broke. Prefer a mechanical check to a judge question when one
exists: it's free and never wrong about itself.

## Reading the results

`node evals/grade.mjs <run dir>` prints the failures; `report.md` in the run
directory has every case with its checks, calls and answer. When a case fails,
read its calls and answer before blaming the change: it can be the model
having a bad day (run with `--repeat 3`), a case that asks too much, or a real
regression. `node evals/grade.mjs <run A> <run B>` puts two runs side by side,
per case.

## Limits

- The assistant is a Haiku sub-agent in Claude Code reading a brief, not
  ChatGPT or the Claude app: their system prompts, memory and tool handling
  differ. Read the results as "is the guidance clear enough for a small
  model", not as a forecast for each app.
- Claude Code cuts long command output, so results over 20 000 characters
  reach the agent as their summary lines plus a file to read.
- There's no web search: the agent uses what it knows about cars, as a model
  without search would.
- One try per case is a coin flip for borderline behaviour: compare versions
  with `--repeat 3`.
- To run them in CI, the same cases and grader would need a runner that calls
  a model's API instead of sub-agents.
