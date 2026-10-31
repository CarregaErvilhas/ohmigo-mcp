// A small line: at most `concurrent` jobs run at once, up to `queued` more wait
// their turn, first come first served, and anything past that is refused at
// once (`full()` makes the error). The wait stays short and bounded, instead
// of work piling up behind a slow dependency until the process runs out of
// memory or the assistant gives up. A job whose `signal` aborts leaves the line
// (`gone()` makes the error), so an abandoned request holds nobody's place.

// The longest anyone stands in line, then it's refused like a full line. A
// ceme-v2 that's slow but alive answers each call inside its 10 s timeout, so
// the breaker never opens and the line could take minutes; assistants give up
// long before that, and a quick honest answer beats a late one.
export const MAX_WAIT_MS = 20_000;

export function limiter({ concurrent, queued, full, gone }) {
  let active = 0;
  const line = [];
  const wait = signal => new Promise((go, stop) => {
    const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', abandon); };
    const place = () => { settle(); go(); };
    const leave = why => { settle(); line.splice(line.indexOf(place), 1); stop(why()); };
    const timer = setTimeout(() => leave(full), MAX_WAIT_MS);
    const abandon = () => leave(gone);
    line.push(place);
    signal?.addEventListener('abort', abandon, { once: true });
  });
  return async function run(job, signal) {
    if (signal?.aborted) throw gone();
    if (active < concurrent) active++;
    else if (line.length >= queued) throw full();
    else await wait(signal);
    try {
      return await job();
    } finally {
      // The place passes straight to the next in line, so a newcomer can't
      // slip in ahead of it.
      const next = line.shift();
      if (next) next();
      else active--;
    }
  };
}
