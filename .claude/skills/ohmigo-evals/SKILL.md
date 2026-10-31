---
name: ohmigo-evals
description: Run ohmigo's behaviour evals (does an assistant call the right tools with the right arguments and present prices honestly?) with Haiku sub-agents, and optionally compare with another git ref. Use after changing tool or argument descriptions, INSTRUCTIONS or result notes (src/mcp.js, src/i18n.js), or when asked to run or compare the evals.
---

# Run the ohmigo evals

What they are, the cases and their matchers: `evals/README.md`. Here, how to
drive one run. Every step runs from the repo root.

## 1. Start the server for the run

Run in the background (Bash `run_in_background: true`), with whatever flags
the request calls for:

```sh
node evals/serve.mjs [--variant full|cut|none] [--ref main] [--repeat 3] [--cases id1,id2]
```

- `--ref <git ref>` serves another version (e.g. `main`) to compare with;
  start one server per version, they can run side by side.
- `--repeat N` gives each case N independent tries (pass rates instead of
  one coin flip); use 3 when comparing two versions.
- `--variant cut` shows the instructions cut at 4 096 characters (Claude
  Code), `none` hides them (clients that ignore them).

Read its output file until it prints `READY <run dir>` and the list of
`case …/brief.md` lines (and any `skip` lines: say why they were skipped).

## 2. One assistant sub-agent per case

For every `case` line, launch a fresh sub-agent, in the background, a few at a
time (5 or 6, then the next batch as they finish):

- `subagent_type: "ohmigo-eval-assistant"` if it's listed; otherwise
  `"general-purpose"` with the body of `.claude/agents/ohmigo-eval-assistant.md`
  as the start of the prompt;
- always `model: "haiku"` and `effort: "low"` (the user's choice for these
  runs);
- prompt: `Brief: <absolute path of the case's brief.md>`, after the agent body
  when using general-purpose.

A fresh agent per case matters: one agent running several cases learns from
the earlier ones. The custom agent types only have Bash, Read and Write; a
general-purpose agent sees every tool in the session (production ohmigo
included), so its prompt must forbid them, as the agent body does. Don't read the agents' transcripts; they answer "done" and
their work is in the case directory.

## 3. Grade, then judge

```sh
node evals/grade.mjs <run dir>
```

It grades what can be checked mechanically and lists `judge pages to grade`.
For each one, launch a sub-agent the same way with
`subagent_type: "ohmigo-eval-judge"` (or general-purpose with the body of
`.claude/agents/ohmigo-eval-judge.md`), `model: "haiku"`, `effort: "low"`,
prompt `Judge file: <absolute path of judge.md>`. Then grade again.

To compare two runs: `node evals/grade.mjs <run A> <run B>`.

## 4. Stop and report

```sh
node evals/serve.mjs stop <run dir>
```

Tell the user: version and variant, pass count, and for every failing case the
check that failed with a short quote of the answer (from
`<run dir>/report.md`). A failure can be the model's, the case's or the
server's: read the case's calls and answer before blaming the change. Don't
commit `evals/runs/` (it's ignored).
