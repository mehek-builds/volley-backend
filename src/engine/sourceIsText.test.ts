import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * No source file may contain a NUL byte.
 *
 * competencyCache.ts shipped in PR #143 joining bullets on a literal '\0'. It WORKED - nothing can
 * collide through a NUL - and it made the file BINARY to git, so every diff of that module rendered
 * as "Bin 3503 -> 3952 bytes". A reviewer could not read it, which is a large part of why the
 * defects in that PR went unseen for a day. A separator that makes its own module unreviewable
 * costs more than the collision it prevents.
 *
 * Cheap, total, and it cannot rot: it walks src/ rather than naming files.
 */
const SRC = path.join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts|tsx|js|mjs|json)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('source stays reviewable', () => {
  test('no file under src/ contains a NUL byte', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (readFileSync(file).includes(0)) offenders.push(path.relative(SRC, file));
    }
    assert.deepEqual(offenders, [], 'a NUL byte makes the file binary to git and unreadable in review');
  });
});
