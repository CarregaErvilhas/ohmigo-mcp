// Starts ohmigo for one eval run and writes a brief for every case.
//
//   node evals/serve.mjs [--variant full|cut|none] [--repeat N] [--cases a,b]
//                        [--ref <git ref>] [--refresh-data] [--live]
//   node evals/serve.mjs stop [<run dir>]      (every run if none given)
//
// It keeps running (the sub-agents call the server through evals/call.mjs)
// until stopped, or after IDLE_MIN minutes without a tool call.
// What a run is and how to drive it: evals/README.md.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CACHE, EVALS, ROOT, RUNS, dated, linkModules, lisbonNow, mcp, readJson, rel } from './lib.mjs';

const IDLE_MIN = 30;
const DATA = join(CACHE, 'chargers.json');

const argv = process.argv.slice(2);
if (argv[0] === 'stop') stop(argv[1]);
else await serve(parseArgs(argv));

function parseArgs(a) {
  const o = { variant: 'full', repeat: 1, cases: null, ref: null, refreshData: false, live: false };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--variant') o.variant = a[++i];
    else if (k === '--repeat') o.repeat = Number(a[++i]);
    else if (k === '--cases') o.cases = a[++i].split(',');
    else if (k === '--ref') o.ref = a[++i];
    else if (k === '--refresh-data') o.refreshData = true;
    else if (k === '--live') o.live = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!['full', 'cut', 'none'].includes(o.variant)) throw new Error('--variant is full, cut or none');
  if (!(o.repeat >= 1)) throw new Error('--repeat is a number >= 1');
  return o;
}

function stop(run) {
  const dirs = run ? [run] : existsSync(RUNS) ? readdirSync(RUNS).map(d => join(RUNS, d)) : [];
  if (!dirs.length) console.log('no runs to stop');
  for (const d of dirs) {
    const m = readJson(join(d, 'manifest.json'));
    if (!m?.pid) { console.log(`skipped ${rel(d)}: no pid in its manifest`); continue; }
    if (!isServe(m.pid)) { console.log(`skipped ${rel(d)}: pid ${m.pid} isn't a serve.mjs (long gone, or the number was reused)`); continue; }
    try { process.kill(m.pid, 'SIGTERM'); console.log(`stopped ${rel(d)} (pid ${m.pid})`); }
    catch (e) { console.log(`skipped ${rel(d)}: pid ${m.pid} (${e.code})`); }
  }
}

// A manifest outlives its server and the system reuses pids, so an old run's
// pid can belong to anything by now: only a serve.mjs gets the signal.
function isServe(pid) {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/).some(a => basename(a) === 'serve.mjs'); }
  catch { return false; } // ps exits with an error when the pid is gone
}

async function serve(o) {
  // Before anything starts: a typo shouldn't cost a download and a server.
  const all = JSON.parse(readFileSync(join(EVALS, 'cases.json'), 'utf8')).cases;
  const cases = o.cases ? all.filter(c => o.cases.includes(c.id)) : all;
  if (o.cases && cases.length !== o.cases.length) throw new Error(`unknown case in --cases: ${o.cases.filter(id => !all.some(c => c.id === id)).join(', ')}`);

  // Here and not at the top: `stop` has to work when src/ doesn't load.
  const [{ DEFAULT_URL }, { INSTRUCTIONS_MAX }] = await Promise.all([import('../src/data.js'), import('../src/mcp.js')]);

  mkdirSync(CACHE, { recursive: true });
  // One frozen copy of the public dataset, so runs compare on the same data.
  // --refresh-data takes this week's.
  if (o.refreshData || !existsSync(DATA)) {
    console.log(`downloading the dataset from ${DEFAULT_URL}…`);
    const r = await fetch(DEFAULT_URL, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`dataset: HTTP ${r.status}`);
    writeFileSync(DATA, Buffer.from(await r.arrayBuffer()));
  }
  const dataset = JSON.parse(readFileSync(DATA, 'utf8'));
  const siteIds = new Set(dataset.sites.map(s => s.id));

  // The server under test: this checkout, or another git ref in a worktree
  // (to compare a change with main). The evals themselves always come from
  // this checkout.
  const root = o.ref ? worktree(o.ref) : ROOT;
  const commit = git(root, 'rev-parse', '--short', 'HEAD') + (o.ref ? '' : git(root, 'status', '--porcelain', '--', 'src', 'offers') ? '+dirty' : '');

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: DATA,
      // Live status off by default: every socket "unknown", the same every
      // run. --live fetches the real NAP feed.
      ...(!o.live && { NAP_STATUS_URL: 'http://127.0.0.1:9/live', LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '1' }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // On every way out, a crash below included: the server lives only as long
  // as this process.
  process.on('exit', () => child.kill('SIGTERM'));
  // A signal with no handler ends the process without that 'exit': the same
  // for a closed terminal (SIGHUP). Set right here, so none slips in early.
  const shutdown = () => process.exit(0);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', c => { out += c; const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });

  // What the assistant reads: the instructions (whole, cut like Claude Code
  // cuts them, or none, like a client that ignores them) and the tool list.
  const init = await mcp(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ohmigo-evals', version: '1' } });
  const full = init.result.instructions ?? '';
  const instructions = o.variant === 'none' ? null : o.variant === 'cut' && full.length > INSTRUCTIONS_MAX ? `${full.slice(0, INSTRUCTIONS_MAX)}… [truncated]` : full;
  const { tools } = (await mcp(url, 'tools/list')).result;
  const toolsShown = tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));

  const runId = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${o.variant}${o.ref ? `-${o.ref.replace(/[^\w.-]+/g, '_')}` : ''}`;
  const run = join(RUNS, runId);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'cases.json'), JSON.stringify({ cases }, null, 2));
  writeFileSync(join(run, 'instructions.txt'), instructions ?? '(none)');
  writeFileSync(join(run, 'tools.json'), JSON.stringify(toolsShown, null, 2));

  const entries = [];
  for (const c of cases) {
    const missing = await unmet(url, c.requires ?? [], siteIds);
    for (let n = 1; n <= o.repeat; n++) {
      const id = o.repeat > 1 ? `${c.id}~${n}` : c.id;
      if (missing.length) { entries.push({ id, case: c.id, skipped: missing.join('; ') }); continue; }
      const dir = join(run, id);
      mkdirSync(join(dir, 'results'), { recursive: true });
      writeFileSync(join(dir, 'brief.md'), brief({ dir: rel(dir), c, instructions, tools: toolsShown }));
      writeFileSync(join(dir, 'calls.jsonl'), '');
      entries.push({ id, case: c.id, dir: rel(dir) });
    }
  }
  const manifest = {
    run: runId, variant: o.variant, ref: o.ref ?? 'working tree', commit, url, pid: process.pid,
    dataAsOf: dataset.generatedAt, live: o.live, startedAt: new Date().toISOString(), cases: entries,
  };
  writeFileSync(join(run, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`READY ${rel(run)}`);
  console.log(`server ${url} (${o.ref ?? 'working tree'} @ ${commit}), dataset of ${dataset.generatedAt}, variant ${o.variant}`);
  for (const e of entries) console.log(e.skipped ? `  skip ${e.id}: ${e.skipped}` : `  case ${e.dir}/brief.md`);
  console.log(`stop with: node evals/serve.mjs stop ${rel(run)}`);

  // Stop on our own when nobody has called for a while: a forgotten server
  // shouldn't live forever.
  const started = Date.now();
  setInterval(() => {
    const last = Math.max(started, ...entries.filter(e => e.dir).map(e => statSync(join(ROOT, e.dir, 'calls.jsonl')).mtimeMs));
    if (Date.now() - last > IDLE_MIN * 60_000) { console.log(`idle for ${IDLE_MIN} min, stopping`); shutdown(); }
  }, 60_000).unref();
}

// What a case needs from the world that isn't ours to freeze: ceme-v2's
// current tariffs and campaigns, and sites in the dataset. When it's gone,
// the case is skipped (and says why) instead of failing for the wrong reason.
//   { "site": "<site id>" }
//   { "tariff": "<name query>", "id": "<regex>", "audience": "<id>", "newCustomersOnly": true }
//   { "promo": "<target regex>", "newCustomers": true|false }
async function unmet(url, reqs, siteIds) {
  const out = [];
  for (const r of reqs) {
    if (r.site) { if (!siteIds.has(r.site)) out.push(`site ${r.site} not in the dataset`); continue; }
    const res = (await mcp(url, 'tools/call', { name: 'list_ceme_tariffs', arguments: { query: r.tariff ?? '', ...(r.audience && { audiences: [r.audience] }) } })).result;
    if (res.isError) { out.push(`ceme-v2 unavailable: ${res.content[0].text}`); continue; }
    const { tariffs = [], promos = [] } = res.structuredContent;
    const fits = t => new RegExp(r.id ?? '', 'i').test(t.tariff_id) && (!r.newCustomersOnly || t.newCustomersOnly) && (!r.audience || t.audience === r.audience);
    if (r.tariff != null && !tariffs.some(fits)) {
      out.push(`no ceme-v2 tariff "${r.tariff}" /${r.id ?? ''}/${r.newCustomersOnly ? ' for new customers' : ''}${r.audience ? ` for ${r.audience}` : ''}`);
    }
    if (r.promo != null && !promos.some(p => new RegExp(r.promo, 'i').test(p.target) && (r.newCustomers === undefined || p.newCustomers === r.newCustomers))) {
      out.push(`no ceme-v2 promotion /${r.promo}/${r.newCustomers !== undefined ? ` newCustomers=${r.newCustomers}` : ''}`);
    }
  }
  return out;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A detached worktree of `ref` in evals/.cache, sharing this checkout's
// node_modules (fine while the dependencies match).
function worktree(ref) {
  const dir = join(CACHE, `ref-${ref.replace(/[^\w.-]+/g, '_')}`);
  if (existsSync(dir)) git(dir, 'checkout', '--quiet', '--detach', ref);
  else git(ROOT, 'worktree', 'add', '--quiet', '--detach', dir, ref);
  linkModules(dir);
  return dir;
}

// The page the sub-agent reads: who it is, what it may do, and everything a
// chat app would put in front of the model for this conversation.
function brief({ dir, c, instructions, tools }) {
  return `# You are the assistant

You are the AI assistant in a chat app (like Claude or ChatGPT). The user has connected the "ohmigo" MCP server, which prices EV charging in Portugal. Answer the user's message at the end of this page exactly as you would in that app: decide whether and which tools to call, call them, read the results, and write your reply.

How this exercise works:
- Call a tool only like this: \`node evals/call.mjs ${dir} <tool_name> '<arguments as JSON>'\`. If the JSON has a single quote in it, send it on stdin instead: \`node evals/call.mjs ${dir} <tool_name> <<'JSON'\` … \`JSON\`. It prints the tool's result as the app would hand it to you. When a result is too long to print, it says which file under ${dir}/results/ holds it: read that file.
- Use only three tools: Bash to run \`node evals/call.mjs\`, Read for this brief and the result files, Write for your reply. Don't open any other file in this repository, don't run any other command, and don't call any other tool, even ohmigo or MCP tools you may see: they aren't the server under test. In the app you'd only have the tools below. Use your own knowledge where you'd use it in the app (a car's specs, where a town is). There's no web search here.
- You can't talk to the user mid-way. If you need to ask them something before you can answer, your reply is that question.
- When you're done, write your reply to the user, exactly as you'd send it, to \`${dir}/answer.md\`. Then answer with the single word: done.

## Now

${lisbonNow()} (Portugal).

## What you remember about this user (the app's memory)

${dated(c.memory) ?? 'Nothing yet.'}

${instructions ? `## The ohmigo server's instructions\n\n${instructions}\n\n` : ''}## The ohmigo tools

\`\`\`json
${JSON.stringify(tools, null, 1)}
\`\`\`

## The user's message

${dated(c.message)}
`;
}
