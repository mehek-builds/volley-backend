import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTROLLED_PORTAL_BINDING_PARAM,
  controlledPortalBinding,
  isControlledTestPortalUrl,
} from './controlledTestPortal';

const saved = {
  enabled: process.env.LITOS_ENABLE_TEST_PORTAL,
  origin: process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN,
  secret: process.env.LITOS_TEST_PORTAL_BINDING_SECRET,
  nodeEnv: process.env.NODE_ENV,
};

test.afterEach(() => {
  if (saved.enabled === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
  else process.env.LITOS_ENABLE_TEST_PORTAL = saved.enabled;
  if (saved.origin === undefined) delete process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN;
  else process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = saved.origin;
  if (saved.secret === undefined) delete process.env.LITOS_TEST_PORTAL_BINDING_SECRET;
  else process.env.LITOS_TEST_PORTAL_BINDING_SECRET = saved.secret;
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.nodeEnv;
});

test('a public controlled portal is exact-origin, path, signature, and environment bound', () => {
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  process.env.NODE_ENV = 'test';
  process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = 'https://qa-tunnel.example.test';
  process.env.LITOS_TEST_PORTAL_BINDING_SECRET = '0123456789abcdef0123456789abcdef';
  const unsigned = 'https://qa-tunnel.example.test/qa/portal-submission?shape=security-code&board=greenhouse&case=run-1';
  const signature = controlledPortalBinding(unsigned, process.env.LITOS_TEST_PORTAL_BINDING_SECRET);
  assert.equal(signature, '886de6f6c7bfe467f993a20fffae9302d1c13ef1ee7f75add9a40119991973fc');
  const signed = new URL(unsigned);
  signed.searchParams.set(CONTROLLED_PORTAL_BINDING_PARAM, signature);
  assert.equal(isControlledTestPortalUrl(signed.toString()), true);
  assert.equal(isControlledTestPortalUrl(unsigned), false);
  assert.equal(isControlledTestPortalUrl(signed.toString().replace('run-1', 'run-2')), false);
  assert.equal(isControlledTestPortalUrl(signed.toString().replace('qa-tunnel', 'employer')), false);
  process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = 'https://trylitos.com:444';
  const productionHost = 'https://trylitos.com:444/qa/portal-submission?shape=security-code&case=run-1';
  const productionHostSigned = new URL(productionHost);
  productionHostSigned.searchParams.set(
    CONTROLLED_PORTAL_BINDING_PARAM,
    controlledPortalBinding(productionHost, process.env.LITOS_TEST_PORTAL_BINDING_SECRET),
  );
  assert.equal(isControlledTestPortalUrl(productionHostSigned.toString()), false);
  process.env.NODE_ENV = 'production';
  assert.equal(isControlledTestPortalUrl(signed.toString()), false);
});

test('local test portals retain their explicit flag gate while production hosts are always rejected', () => {
  process.env.NODE_ENV = 'test';
  delete process.env.LITOS_ENABLE_TEST_PORTAL;
  assert.equal(isControlledTestPortalUrl('http://localhost:3300/qa/portal-submission'), false);
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  assert.equal(isControlledTestPortalUrl('http://localhost:3300/qa/portal-submission'), true);
  assert.equal(isControlledTestPortalUrl('https://trylitos.com/qa/portal-submission'), false);
  assert.equal(isControlledTestPortalUrl('https://www.trylitos.com/qa/portal-submission'), false);
  assert.equal(isControlledTestPortalUrl('https://trylitos.com:444/qa/portal-submission'), false);
  assert.equal(isControlledTestPortalUrl('https://www.trylitos.com:444/qa/portal-submission'), false);
  process.env.NODE_ENV = 'production';
  assert.equal(isControlledTestPortalUrl('http://localhost:3300/qa/portal-submission'), false);
  assert.equal(isControlledTestPortalUrl('https://trylitos.com/qa/portal-submission'), false);
  assert.equal(isControlledTestPortalUrl('https://www.trylitos.com/qa/portal-submission'), false);
});
