// Shared by the eval scripts (serve, call, grade): paths, the MCP client, and
// the matchers the cases use to describe what a good answer does.
// How the evals work: evals/README.md.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVALS = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(EVALS);
export const CACHE = join(EVALS, '.cache');
export const RUNS = join(EVALS, 'runs');

// Some clients cut the server's instructions. Claude Code keeps this many
// characters; the "cut" variant shows the assistant exactly that.
export const CUT_AT = 4096;

export const readJson = (p, fallback) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
export const readLines = p => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
export const rel = p => relative(ROOT, p) || '.';

// A case directory must be inside evals/runs: call.mjs writes there on behalf
// of a sub-agent, and nowhere else.
export function caseDir(arg) {
  const dir = resolve(ROOT, arg);
  if (!dir.startsWith(RUNS + sep)) throw new Error(`${arg} is not a case directory under evals/runs`);
  if (!existsSync(join(dir, 'brief.md'))) throw new Error(`${arg} has no brief.md`);
  return dir;
}

// One JSON-RPC request to the server, the way an MCP client sends it. The
// server answers as server-sent events; the reply is the message with our id.
export async function mcp(url, method, params = {}) {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await r.text();
  const msgs = r.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
    : [JSON.parse(body)];
  const m = msgs.find(x => x.id === 1);
  if (!m) throw new Error(`${method}: no answer (HTTP ${r.status})`);
  return m;
}

// Matchers. A case says what the calls' arguments should look like, per
// argument:
//   true / false    the argument is there / isn't
//   [min, max]      a number in that range
//   "regex"         the value (JSON for arrays and objects) matches, case-insensitive
// The key "*" matches the regex against all the arguments as JSON, for "one
// of these arguments" ("place or lat/lon near Coimbra").
export function matchValue(v, m) {
  if (m === true) return v !== undefined && v !== null;
  if (m === false) return v === undefined || v === null;
  if (Array.isArray(m)) return typeof v === 'number' && v >= m[0] && v <= m[1];
  if (typeof m === 'string') return v !== undefined && new RegExp(m, 'i').test(typeof v === 'string' ? v : JSON.stringify(v));
  throw new Error(`unknown matcher ${JSON.stringify(m)}`);
}

export const matchArgs = (args = {}, spec = {}) =>
  Object.entries(spec).every(([k, m]) => k === '*' ? new RegExp(m, 'i').test(JSON.stringify(args)) : matchValue(args[k], m));

// `tool` is a regex on the tool name ("estimate_charging_cost|lookup_charger").
// `ok: true` only counts calls that didn't come back as an error.
export const callMatches = (call, exp) =>
  new RegExp(`^(?:${exp.tool ?? '.*'})$`).test(call.tool) && matchArgs(call.args, exp.args)
  && (exp.ok === undefined || exp.ok === !call.isError);

const show = exp => `${exp.tool ?? 'any tool'}${exp.args ? ` ${JSON.stringify(exp.args)}` : ''}${exp.ok ? ' (ok)' : ''}`;

// Every deterministic check of one case against what the assistant did.
// Judge questions are graded elsewhere (they need a model).
export function checkCase(expect = {}, calls, answer) {
  const out = [];
  for (const exp of expect.calls ?? []) out.push({ check: `calls ${show(exp)}`, pass: calls.some(c => callMatches(c, exp)) });
  for (const exp of expect.noCalls ?? []) {
    const hit = calls.find(c => callMatches(c, exp));
    out.push({ check: `no call ${show(exp)}`, pass: !hit, ...(hit && { got: `${hit.tool} ${JSON.stringify(hit.args)}` }) });
  }
  if (expect.every) {
    const scope = calls.filter(c => new RegExp(`^(?:${expect.every.tool ?? '.*'})$`).test(c.tool));
    const bad = scope.find(c => !matchArgs(c.args, expect.every.args));
    out.push({ check: `every call ${show(expect.every)}`, pass: !bad, ...(bad && { got: `${bad.tool} ${JSON.stringify(bad.args)}` }) });
  }
  for (const re of expect.answer?.match ?? []) out.push({ check: `answer matches /${re}/`, pass: answer != null && new RegExp(re, 'i').test(answer) });
  for (const re of expect.answer?.noMatch ?? []) {
    const m = answer?.match(new RegExp(re, 'i'));
    out.push({ check: `answer doesn't match /${re}/`, pass: answer != null && !m, ...(m && { got: m[0] }) });
  }
  return out;
}

// Judge answers: "yes" and "n/a" pass, "no" fails.
export function checkJudge(questions = [], verdicts) {
  return questions.map((q, i) => {
    const v = String(verdicts?.[String(i + 1)] ?? '').toLowerCase();
    return { check: `judge: ${q}`, pass: v ? v !== 'no' : null, ...(v && { got: v }) };
  });
}

export const lisbonNow = (d = new Date()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Lisbon', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(d);

// Cases say "{{month}}" and "{{year}}" (Portugal's current month, in
// Portuguese) where a fixed date would go stale: "this month's sessions".
export function dated(text, d = new Date()) {
  if (text == null) return text;
  const part = type => new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', [type]: type === 'month' ? 'long' : 'numeric' }).format(d);
  return text.replaceAll('{{month}}', part('month')).replaceAll('{{year}}', part('year'));
}
