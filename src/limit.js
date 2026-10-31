// A small line: at most `concurrent` jobs run at once, up to `queued` more wait
// their turn, first come first served, and anything past that is refused at
// once (`full()` makes the error). The wait stays short and bounded, instead
// of work piling up behind a slow dependency until the process runs out of
// memory or the assistant gives up. A job whose `signal` aborts leaves the line
// (`gone()` makes the error), so an abandoned request holds nobody's place.
export function limiter({ concurrent, queued, full, gone }) {
  let active = 0;
  const line = [];
  const wait = signal => new Promise((go, stop) => {
    line.push(go);
    signal?.addEventListener('abort', () => {
      const i = line.indexOf(go);
      if (i < 0) return;
      line.splice(i, 1);
      stop(gone());
    }, { once: true });
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
