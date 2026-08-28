import assert from 'node:assert/strict';
import test from 'node:test';
import { withBillingAccountLock } from './billingAccountLock';

function fakeConnector(record: string[]) {
  let connections = 0;
  const connect = async () => {
    connections += 1;
    return {
      query: async (text: string, values?: unknown[]) => {
        record.push(`${text}:${String(values?.[0] ?? '')}`);
        return { rows: text.includes('pg_advisory_unlock') ? [{ released: true }] : [{}] };
      },
      end: async () => { record.push('end'); },
    };
  };
  return { connect, connections: () => connections };
}

test('the account lock spans the operation and releases its dedicated session', async () => {
  const record: string[] = [];
  const fake = fakeConnector(record);
  const value = await withBillingAccountLock('user-1', async () => {
    record.push('operation');
    return 42;
  }, fake.connect);

  assert.equal(value, 42);
  assert.equal(fake.connections(), 1);
  assert.deepEqual(record.map((item) => item.split(':')[0]), [
    'select pg_advisory_lock(hashtextextended($1, 0',
    'operation',
    'select pg_advisory_unlock(hashtextextended($1, 0',
    'end',
  ]);
  assert.match(record[0], /entitlement:user-1$/);
  assert.match(record[2], /entitlement:user-1$/);
});

test('nested checkout reconciliation reuses the owned account lock', async () => {
  const record: string[] = [];
  const fake = fakeConnector(record);
  await withBillingAccountLock('user-2', async () => {
    record.push('outer');
    await withBillingAccountLock('user-2', async () => {
      record.push('inner');
    }, fake.connect);
  }, fake.connect);

  assert.equal(fake.connections(), 1);
  assert.deepEqual(record.filter((item) => item === 'outer' || item === 'inner'), ['outer', 'inner']);
  assert.equal(record.filter((item) => item.includes('pg_advisory_lock')).length, 1);
  assert.equal(record.filter((item) => item.includes('pg_advisory_unlock')).length, 1);
});

test('a failed operation still releases the lock and closes the session', async () => {
  const record: string[] = [];
  const fake = fakeConnector(record);
  await assert.rejects(
    () => withBillingAccountLock('user-3', async () => {
      throw new Error('stop');
    }, fake.connect),
    /stop/,
  );
  assert.equal(record.filter((item) => item.includes('pg_advisory_unlock')).length, 1);
  assert.equal(record.at(-1), 'end');
});
