// Grades an eval run, or compares two.
//
//   node evals/grade.mjs <run dir>              writes <run dir>/report.md
//   node evals/grade.mjs <run dir A> <run dir B>
//
// Deterministic checks (the calls and the answer's text) are graded here.
// Judge questions need a model: for every case that has them and no
// judge.json yet, this writes judge.md for a judge sub-agent and lists it
// as pending. Run again once the judges are done. See evals/README.md.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, checkCase, checkJudge, dated, readJson, readLines, rel } from './lib.mjs';

// The judge sees the tool results the assistant saw, up to this much.
const JUDGE_RESULTS_MAX = 120_000;

const dirs = process.argv.slice(2).map(d => resolve(ROOT, d));
if (!dirs.length || dirs.length > 2) { console.error('usage: node evals/grade.mjs <run dir> [<run dir to compare>]'); process.exit(2); }
const graded = dirs.map(grade);
if (graded.length === 1) print(graded[0]);
else compare(...graded);

function grade(run) {
  const manifest = readJson(join(run, 'manifest.json'));
  if (!manifest) throw new Error(`${rel(run)} has no manifest.json`);
  const cases = new Map(readJson(join(run, 'cases.json')).cases.map(c => [c.id, c]));
  const rows = manifest.cases.map(e => {
    const c = cases.get(e.case);
    if (e.skipped) return { id: e.id, case: e.case, status: 'skipped', note: e.skipped, checks: [] };
    const dir = join(ROOT, e.dir);
    const calls = readLines(join(dir, 'calls.jsonl'));
    const answer = existsSync(join(dir, 'answer.md')) ? readFileSync(join(dir, 'answer.md'), 'utf8') : null;
    if (answer == null) return { id: e.id, case: e.case, status: 'no answer', checks: [], calls };
    const checks = checkCase(c.expect, calls, answer);
    const questions = c.expect?.judge ?? [];
    if (questions.length) {
      const verdicts = readJson(join(dir, 'judge.json'));
      if (!verdicts) writeFileSync(join(dir, 'judge.md'), judgePage(e, c, dir, calls, answer));
      checks.push(...checkJudge(questions, verdicts));
    }
    const status = checks.some(x => x.pass === false) ? 'fail' : checks.some(x => x.pass === null) ? 'pending' : 'pass';
    return { id: e.id, case: e.case, status, checks, calls, answer };
  });
  const report = { manifest, rows };
  writeFileSync(join(run, 'report.md'), markdown(report));
  return report;
}

function print({ manifest, rows }) {
  const count = s => rows.filter(r => r.status === s).length;
  const ran = rows.length - count('skipped');
  console.log(`${manifest.run}: ${manifest.ref} @ ${manifest.commit}, variant ${manifest.variant}, dataset ${manifest.dataAsOf}`);
  console.log(`pass ${count('pass')}/${ran}, fail ${count('fail')}, pending ${count('pending')}, no answer ${count('no answer')}, skipped ${count('skipped')}`);
  for (const r of rows) {
    if (r.status === 'pass') continue;
    console.log(`  ${r.status.padEnd(9)} ${r.id}${r.note ? `: ${r.note}` : ''}`);
    for (const x of r.checks.filter(x => x.pass !== true)) console.log(`      ${x.pass === null ? '?' : '✗'} ${x.check}${x.got ? ` (got ${x.got})` : ''}`);
  }
  const pending = rows.filter(r => r.status === 'pending' || (r.status === 'fail' && r.checks.some(x => x.pass === null)));
  if (pending.length) {
    console.log('\njudge pages to grade:');
    for (const r of pending) console.log(`  ${manifest.cases.find(e => e.id === r.id).dir}/judge.md`);
  }
  console.log(`\nreport: ${rel(join(ROOT, 'evals', 'runs', manifest.run, 'report.md'))}`);
}

// Two runs side by side, per case (repeats pooled: "2/3" = passed 2 of 3).
function compare(a, b) {
  const tally = rows => {
    const m = new Map();
    for (const r of rows) {
      const t = m.get(r.case) ?? { pass: 0, ran: 0, skipped: false };
      if (r.status === 'skipped') t.skipped = true;
      else { t.ran++; if (r.status === 'pass') t.pass++; }
      m.set(r.case, t);
    }
    return m;
  };
  const ta = tally(a.rows), tb = tally(b.rows);
  const fmt = t => !t ? '—' : t.skipped && !t.ran ? 'skip' : `${t.pass}/${t.ran}`;
  const head = r => `${r.manifest.ref} @ ${r.manifest.commit} (${r.manifest.variant})`;
  console.log(`A: ${head(a)}\nB: ${head(b)}\n`);
  console.log(`${'case'.padEnd(28)} ${'A'.padEnd(6)} B`);
  for (const id of new Set([...ta.keys(), ...tb.keys()])) {
    const x = fmt(ta.get(id)), y = fmt(tb.get(id));
    console.log(`${id.padEnd(28)} ${x.padEnd(6)} ${y}${x !== y ? '  ←' : ''}`);
  }
  const sum = t => [...t.values()].reduce((s, v) => ({ pass: s.pass + v.pass, ran: s.ran + v.ran }), { pass: 0, ran: 0 });
  const sa = sum(ta), sb = sum(tb);
  console.log(`${'total'.padEnd(28)} ${`${sa.pass}/${sa.ran}`.padEnd(6)} ${sb.pass}/${sb.ran}`);
}

function markdown({ manifest, rows }) {
  const lines = [`# Eval run ${manifest.run}`, '',
    `Server: ${manifest.ref} @ ${manifest.commit} · variant: ${manifest.variant} · dataset: ${manifest.dataAsOf} · live status: ${manifest.live ? 'on' : 'off'}`, ''];
  for (const r of rows) {
    lines.push(`## ${r.id}: ${r.status}`, '');
    if (r.note) lines.push(r.note, '');
    for (const x of r.checks) lines.push(`- ${x.pass === true ? '✓' : x.pass === false ? '✗' : '?'} ${x.check}${x.got ? ` (got ${x.got})` : ''}`);
    if (r.calls?.length) lines.push('', 'Calls:', ...r.calls.map(c => `- ${c.tool} ${JSON.stringify(c.args)}${c.isError ? ` → error${c.code ? ` ${c.code}` : ''}` : ''}`));
    if (r.answer != null) lines.push('', 'Answer:', '', ...r.answer.trim().split('\n').map(l => `> ${l}`));
    lines.push('');
  }
  return lines.join('\n');
}

// The judge's page: what the user asked, what the tools returned, what the
// assistant answered, and yes/no questions.
function judgePage(e, c, dir, calls, answer) {
  let budget = JUDGE_RESULTS_MAX;
  const results = existsSync(join(dir, 'results')) ? readdirSync(join(dir, 'results')).sort().map(f => {
    const t = readFileSync(join(dir, 'results', f), 'utf8');
    const s = t.length <= budget ? t : `${t.slice(0, Math.max(0, budget))}\n[… cut]`;
    budget -= s.length;
    return `### ${f}\n\n\`\`\`\n${s}\n\`\`\``;
  }) : [];
  return `# Judge one answer

An AI assistant answered a user in a chat app, using the tools of "ohmigo", a server that prices EV charging in Portugal. Grade the assistant's answer with the questions at the end.

For each question answer "yes", "no" or "n/a" (only when the question says when n/a applies). Judge only the answer to the user, using the tool results to know what the assistant had in front of it. Be strict: "yes" means the answer clearly does it.

Write your verdicts as JSON to \`${rel(dir)}/judge.json\`, numbered like the questions, e.g. {"1": "yes", "2": "n/a"}, then answer with the single word: done. Don't open any other file.

## The user's message

${dated(c.message)}
${c.memory ? `\nWhat the assistant remembered about the user: ${dated(c.memory)}\n` : ''}
## The tool calls

${calls.length ? calls.map(x => `- ${x.tool} ${JSON.stringify(x.args)}`).join('\n') : '(none)'}

## The tool results

${results.join('\n\n') || '(none)'}

## The assistant's answer

${answer}

## Questions

${c.expect.judge.map((q, i) => `${i + 1}. ${q}`).join('\n')}
`;
}
