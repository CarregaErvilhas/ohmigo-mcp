// Voltaria knowledge base (pt-PT EV guides and dated facts), read from the
// `voltaria/` git submodule. Content is static per deploy, so it is read once
// and cached; topics are checked against what is on disk, never joined into a
// path from user input.
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../voltaria/', import.meta.url);
const SAFE = /^[a-z0-9][a-z0-9-]*$/;

export const VOLTARIA_AVAILABLE = existsSync(new URL('skills/', ROOT));

// The skill's own "when to use me" line, from its frontmatter: what the
// assistant needs to pick a topic. Values are JSON-quoted strings.
export function descriptionOf(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const line = m && /^description:\s*(.+)$/m.exec(m[1]);
  if (!line) return '';
  const v = line[1].trim();
  try { return v.startsWith('"') ? JSON.parse(v) : v; } catch { return v; }
}

let cache = null;
function load() {
  if (cache) return cache;
  const guides = new Map();
  for (const d of readdirSync(new URL('skills/', ROOT), { withFileTypes: true })) {
    if (!d.isDirectory() || !SAFE.test(d.name)) continue;
    const f = new URL(`skills/${d.name}/SKILL.md`, ROOT);
    if (existsSync(f)) guides.set(d.name, readFileSync(f, 'utf8'));
  }
  const facts = new Map();
  const kdir = new URL('knowledge/', ROOT);
  if (existsSync(kdir)) {
    for (const f of readdirSync(kdir)) {
      const m = /^([a-z0-9-]+)\.json$/.exec(f);
      if (m) facts.set(m[1], JSON.parse(readFileSync(new URL(f, kdir), 'utf8')).entries ?? []);
    }
  }
  return (cache = { guides, facts });
}

export const topics = () => {
  const { guides, facts } = load();
  return {
    guides: [...guides].sort(([a], [b]) => a.localeCompare(b)).map(([topic, md]) => ({ topic, description: descriptionOf(md) })),
    facts: [...facts.keys()].sort(),
  };
};

export const getGuide = topic => {
  const text = load().guides.get(topic);
  if (text === undefined) throw new Error(`Unknown guide "${topic}".`);
  return { topic, content: text };
};

// Every word of the query must appear (any order). Entries not started yet are
// left out; ended ones stay, flagged, because the history is the point of some
// topics (past incentive editions).
export const getFacts = (topic, query, lang = 'pt', now = new Date()) => {
  const entries = load().facts.get(topic);
  if (!entries) throw new Error(`Unknown facts topic "${topic}".`);
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter(e => !e.validFrom || new Date(e.validFrom) <= now)
    .map(e => ({ e, text: e.text?.[lang] ?? e.text?.pt ?? e.text?.en ?? '' }))
    .filter(({ text }) => words.every(w => text.toLowerCase().includes(w)))
    .map(({ e, text }) => ({
      id: e.id, text, source: e.source, checkedAt: e.checkedAt,
      validFrom: e.validFrom, validTo: e.validTo,
      ended: !!e.validTo && new Date(e.validTo) < now,
    }));
};
