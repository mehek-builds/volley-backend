import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

type LoadFunction = (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

test('an ordinary awaited pooled query falls back once to the direct endpoint after read-only retries exhaust', async () => {
  const originalLoad = (Module as unknown as { _load: LoadFunction })._load;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDirectUrl = process.env.DATABASE_DIRECT_URL;
  const originalVercel = process.env.VERCEL;

  const pooledCalls: unknown[][] = [];
  const directCalls: unknown[][] = [];
  let connectCalls = 0;
  let endCalls = 0;

  class FakePool {
    query(...args: unknown[]) {
      pooledCalls.push(args);
      return Promise.reject(pgError('25006', 'cannot execute UPDATE in a read-only transaction'));
    }
  }

  class FakeClient {
    constructor(readonly options: unknown) {}

    async connect() {
      connectCalls += 1;
    }

    query(...args: unknown[]) {
      assert.equal(this instanceof FakeClient, true, 'direct fallback must preserve pg Client.query this binding');
      directCalls.push(args);
      const callback = args[args.length - 1];
      assert.equal(typeof callback, 'function', 'direct fallback should wrap pg callback results itself');
      (callback as (error: Error | null, result: unknown) => void)(null, { rowCount: 1, rows: [{ ok: true }] });
      return undefined;
    }

    async end() {
      endCalls += 1;
    }
  }

  (Module as unknown as { _load: LoadFunction })._load = function patchedLoad(
    this: unknown,
    request,
    parent,
    isMain,
  ) {
    if (request === 'pg') return { Pool: FakePool, Client: FakeClient };
    if (request === 'drizzle-orm/node-postgres') return { drizzle: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
  } as LoadFunction;

  process.env.DATABASE_URL = 'postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/litos?sslmode=require';
  process.env.DATABASE_DIRECT_URL = 'postgresql://user:secret@ep-example.us-east-2.aws.neon.tech/litos?sslmode=require';
  delete process.env.VERCEL;

  try {
    const resolved = require.resolve('./index');
    delete require.cache[resolved];
    const { pool } = require('./index') as typeof import('./index');

    const result = await pool.query('update users set email_verified = $1 where id = $2', [true, 'user-1']);

    assert.deepEqual(result, { rowCount: 1, rows: [{ ok: true }] });
    assert.equal(pooledCalls.length, 3, 'the pooled endpoint gets the configured retry budget first');
    assert.equal(directCalls.length, 1, 'the direct endpoint is used once after pooled retries exhaust');
    assert.deepEqual(directCalls[0], [
      'update users set email_verified = $1 where id = $2',
      [true, 'user-1'],
      directCalls[0]![2],
    ]);
    assert.equal(typeof directCalls[0]![2], 'function');
    assert.equal(connectCalls, 1);
    assert.equal(endCalls, 1, 'the one-off direct client is closed after the fallback query');
  } finally {
    (Module as unknown as { _load: LoadFunction })._load = originalLoad;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDirectUrl === undefined) delete process.env.DATABASE_DIRECT_URL;
    else process.env.DATABASE_DIRECT_URL = originalDirectUrl;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    delete require.cache[require.resolve('./index')];
  }
});

test('the direct fallback preserves drizzle config-object query results', async () => {
  const originalLoad = (Module as unknown as { _load: LoadFunction })._load;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDirectUrl = process.env.DATABASE_DIRECT_URL;
  const originalVercel = process.env.VERCEL;

  class FakePool {
    query() {
      return Promise.reject(pgError('25006', 'cannot execute UPDATE in a read-only transaction'));
    }
  }

  class FakeClient {
    constructor(readonly options: unknown) {}

    async connect() {}

    query(config: unknown, values: unknown, callback: unknown) {
      assert.equal(this instanceof FakeClient, true, 'config-object fallback must call the bound client query');
      assert.deepEqual(config, { text: 'update generated_resumes set spec = $1 where id = $2 returning id' });
      assert.deepEqual(values, ['{}', 'resume-1']);
      assert.equal(typeof callback, 'function', 'config-object fallback should receive the callback in the pg slot');
      (callback as (error: Error | null, result: unknown) => void)(null, { rowCount: 1, rows: [{ id: 'resume-1' }] });
      return undefined;
    }

    async end() {}
  }

  (Module as unknown as { _load: LoadFunction })._load = function patchedLoad(
    this: unknown,
    request,
    parent,
    isMain,
  ) {
    if (request === 'pg') return { Pool: FakePool, Client: FakeClient };
    if (request === 'drizzle-orm/node-postgres') return { drizzle: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
  } as LoadFunction;

  process.env.DATABASE_URL = 'postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/litos?sslmode=require';
  process.env.DATABASE_DIRECT_URL = 'postgresql://user:secret@ep-example.us-east-2.aws.neon.tech/litos?sslmode=require';
  delete process.env.VERCEL;

  try {
    const resolved = require.resolve('./index');
    delete require.cache[resolved];
    const { pool } = require('./index') as typeof import('./index');

    const result = await pool.query(
      { text: 'update generated_resumes set spec = $1 where id = $2 returning id' },
      ['{}', 'resume-1'],
    );

    assert.deepEqual(result, { rowCount: 1, rows: [{ id: 'resume-1' }] });
  } finally {
    (Module as unknown as { _load: LoadFunction })._load = originalLoad;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDirectUrl === undefined) delete process.env.DATABASE_DIRECT_URL;
    else process.env.DATABASE_DIRECT_URL = originalDirectUrl;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    delete require.cache[require.resolve('./index')];
  }
});
