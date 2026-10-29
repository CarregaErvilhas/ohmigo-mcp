// One JSON line per tool call on stdout (Zerops collects it) and running
// counters for /healthz: which tools are called, how often they fail, how
// slow and how big their answers are. Never the arguments: they carry the
// user's location, car and tariffs.

export const toolStats = new Map(); // name -> { calls, errors, throws, msTotal, msMax, bytesMax }

export const log = (level, event, fields = {}) =>
  (level === 'error' ? console.error : console.log)(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));

export function logged(name, fn) {
  return async (...args) => {
    const t0 = performance.now();
    const s = toolStats.get(name) ?? toolStats.set(name, { calls: 0, errors: 0, throws: 0, msTotal: 0, msMax: 0, bytesMax: 0 }).get(name);
    s.calls++;
    try {
      const r = await fn(...args);
      const ms = Math.round(performance.now() - t0), bytes = JSON.stringify(r).length;
      if (r?.isError) s.errors++;
      s.msTotal += ms; s.msMax = Math.max(s.msMax, ms); s.bytesMax = Math.max(s.bytesMax, bytes);
      log('info', 'tool', { tool: name, ms, isError: !!r?.isError, code: r?.structuredContent?.code, bytes });
      return r;
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      s.throws++; s.msTotal += ms; s.msMax = Math.max(s.msMax, ms);
      log('error', 'tool_throw', { tool: name, ms, error: e.message });
      throw e;
    }
  };
}

export const statsSummary = () => Object.fromEntries([...toolStats].map(([k, s]) =>
  [k, { calls: s.calls, errors: s.errors, throws: s.throws, avgMs: s.calls ? Math.round(s.msTotal / s.calls) : 0, maxMs: s.msMax, maxBytes: s.bytesMax }]));
