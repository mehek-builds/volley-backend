import assert from 'node:assert/strict';
import test from 'node:test';
import { dedicatedDatabaseUrl } from './index';

test('derives a direct Neon endpoint for connection-bound advisory locks', () => {
  const url = dedicatedDatabaseUrl({
    DATABASE_URL: 'postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/litos?sslmode=require',
  });
  assert.equal(new URL(url).hostname, 'ep-example.us-east-2.aws.neon.tech');
});

test('prefers an explicit direct database URL and rejects unknown poolers', () => {
  const direct = 'postgresql://user:secret@direct.example.com/litos';
  assert.equal(dedicatedDatabaseUrl({ DATABASE_URL: 'postgresql://ignored', DATABASE_DIRECT_URL: direct }), direct);
  assert.throws(
    () => dedicatedDatabaseUrl({ DATABASE_URL: 'postgresql://user:secret@pgbouncer.example.com/litos' }),
    /session-pinned/,
  );
});
