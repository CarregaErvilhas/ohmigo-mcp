// A small line: at most `concurrent` jobs run at once, up to `queued` more wait
// their turn, first come first served, and anything past that is refused at
// once (`full()` makes the error). The wait stays short and bounded, instead
// of work piling up behind a slow dependency until the process runs out of
// memory or the assistant gives up.
export function limiter({ concurrent, queued, full }) {
  let active = 0;
  const line = [];
  return async function run(job) {
    if (active < concurrent) active++;
    else if (line.length >= queued) throw full();
    else await new Promise(go => line.push(go));
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
