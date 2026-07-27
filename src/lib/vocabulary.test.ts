import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findRetired, formatHits } from './vocabulary';

/* The backend has less user-facing copy than the other two repos, but what it
   does have reaches people directly and is easy to forget: the verification
   email every new user receives, and the error strings the dashboard renders
   verbatim. The verification email was carrying "thoughtful recruiter
   outreach" for months precisely because it lives here, not on a page. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      /* src/llm holds the system prompts. Their reader is Claude, not a
         student, and they deliberately use our internal names for things
         because that is what the schema calls them. */
      if (e.name === 'node_modules' || e.name === 'llm') continue;
      walk(p, out);
    } else if (/\.ts$/.test(e.name) && !e.name.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

const FILES = walk('src').filter((f) => !f.endsWith('vocabulary.ts'));

describe('Litos vocabulary', () => {
  test('no user-facing copy uses a retired word', () => {
    assert.ok(FILES.length > 10, `globbed only ${FILES.length} files`);
    const hits = findRetired(FILES.map((path) => ({ path, source: readFileSync(path, 'utf8') })));
    assert.equal(
      hits.length,
      0,
      `\n\nThe terminology audit retired these words. Reword, or add a \`vocab-allow\` comment on the line if you are certain.\n\n${formatHits(hits)}\n`,
    );
  });
});
