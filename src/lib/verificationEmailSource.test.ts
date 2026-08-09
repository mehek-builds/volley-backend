import assert from 'node:assert/strict';
import test from 'node:test';
import { verificationEmailSource } from './verificationEmailSource';

const deliverability = (deliverable: boolean) => async () => ({ deliverable }) as never;

test('uses the Litos application alias without a connected Gmail or Outlook inbox', async () => {
  let connectionChecks = 0;
  const source = await verificationEmailSource('user-1', {
    applicationAliasDeliverability: deliverability(true),
    hasActiveEmailConnection: async () => {
      connectionChecks += 1;
      return false;
    },
  });

  assert.equal(source, 'application_alias');
  assert.equal(connectionChecks, 0);
});

test('falls back to a connected inbox when the application alias is unavailable', async () => {
  const source = await verificationEmailSource('user-1', {
    applicationAliasDeliverability: deliverability(false),
    hasActiveEmailConnection: async () => true,
  });

  assert.equal(source, 'connected_inbox');
});

test('fails closed when neither verification inbox can be proven', async () => {
  const source = await verificationEmailSource('user-1', {
    applicationAliasDeliverability: async () => { throw new Error('route unavailable'); },
    hasActiveEmailConnection: async () => { throw new Error('provider unavailable'); },
  });

  assert.equal(source, null);
});
