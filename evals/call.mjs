// How a sub-agent calls an ohmigo tool during an eval:
//
//   node evals/call.mjs <case dir> <tool> '<json arguments>'
//   node evals/call.mjs <case dir> <tool> <<'JSON' … JSON      (arguments on stdin)
//
// Prints the result's text, which is what most chat apps hand the model (a
// few summary lines and the full JSON), logs the call in <case dir>/calls.jsonl
// for grade.mjs, and keeps the result in <case dir>/results/ for the judge.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { caseDir, mcp, readJson, readLines, rel } from './lib.mjs';

// Sub-agents run in Claude Code, which cuts long command output. Past this,
// the full result goes to a file the agent reads instead (pretty-printed, so
// it reads line by line).
const PRINT_MAX = 20_000;

const [dirArg, tool, json] = process.argv.slice(2);
if (!dirArg || !tool) { console.error('usage: node evals/call.mjs <case dir> <tool> \'<json arguments>\''); process.exit(2); }
// It ends up in a file name below, so it can't be allowed to walk out of the
// case directory.
if (!/^[a-z_]+$/.test(tool)) { console.error(`${tool} isn't a tool name`); process.exit(2); }
const dir = caseDir(dirArg);
const { url } = readJson(join(dirname(dir), 'manifest.json'));

let args;
try {
  const raw = json ?? (process.stdin.isTTY ? '{}' : readFileSync(0, 'utf8'));
  args = JSON.parse(raw.trim() || '{}');
} catch (e) {
  console.error(`The arguments aren't valid JSON: ${e.message}`);
  process.exit(2);
}

const n = readLines(join(dir, 'calls.jsonl')).length + 1;
let text, isError, code;
try {
  const m = await mcp(url, 'tools/call', { name: tool, arguments: args });
  if (m.error) { isError = true; text = `Error: ${m.error.message}`; }
  else {
    isError = !!m.result.isError;
    code = m.result.structuredContent?.code;
    text = m.result.content.map(c => c.text ?? '').join('\n');
  }
} catch (e) {
  console.error(`The eval server isn't answering (${e.message}). Is evals/serve.mjs still running?`);
  process.exit(3);
}

appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ n, tool, args, isError, ...(code && { code }), chars: text.length })}\n`);
const file = join(dir, 'results', `${String(n).padStart(2, '0')}-${tool}.txt`);
writeFileSync(file, pretty(text));

if (text.length <= PRINT_MAX) console.log(text);
else {
  // The summary lines come before the JSON (see `ok` in src/mcp.js).
  const cut = text.indexOf('\n\n{');
  console.log(`${cut > 0 ? text.slice(0, cut) : text.slice(0, 2000)}\n\n[The full result, ${text.length} characters of JSON, is in ${rel(file)}. Read it before you answer: the summary above leaves out most of it.]`);
}

// The JSON part on its own lines, for the Read tool and for people.
function pretty(t) {
  const i = t.indexOf('{');
  try { return `${t.slice(0, i)}${JSON.stringify(JSON.parse(t.slice(i)), null, 1)}\n`; } catch { return t; }
}
