import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extensionClientNeedsSafetyUpdate,
  extensionSafetyUpdatePathIsEvidenceOnly,
} from './clientCompatibility';

const EXTENSION_ORIGIN = 'chrome-extension://bdbedbmkjpfioknfpmhookefabipjaad';

test('extension capability calls fail closed below the safety cutover', () => {
  assert.equal(extensionClientNeedsSafetyUpdate({}, EXTENSION_ORIGIN), true);
  assert.equal(extensionClientNeedsSafetyUpdate({ 'x-litos-version': '0.6.1' }, EXTENSION_ORIGIN), true);
  assert.equal(extensionClientNeedsSafetyUpdate({
    'x-litos-client': 'extension',
    'x-litos-version': '0.6.1',
  }), true);
  assert.equal(extensionClientNeedsSafetyUpdate({
    'x-litos-client': 'extension',
    'x-litos-version': '0.6.2',
  }), false);
  assert.equal(extensionClientNeedsSafetyUpdate({
    'x-litos-client': 'extension',
    'x-litos-version': '1.0.0',
  }), false);
  assert.equal(extensionClientNeedsSafetyUpdate({}, 'https://trylitos.com'), false);
});

test('only metadata, health, and post-boundary evidence bypass the cutover', () => {
  for (const [method, path] of [
    ['OPTIONS', '/profile'],
    ['GET', '/v1/meta'],
    ['GET', '/health'],
    ['POST', '/track'],
    ['POST', '/autofill/event'],
    ['POST', '/applications/00000000-0000-4000-8000-000000000001/manual-submission-outcome'],
    ['POST', '/applications/00000000-0000-4000-8000-000000000001/manual-submission-resolution'],
    ['POST', '/applications/00000000-0000-4000-8000-000000000001/submission/extension-outcome'],
    ['POST', '/applications/00000000-0000-4000-8000-000000000001/submission/unverified'],
    ['POST', '/applications/00000000-0000-4000-8000-000000000001/submission/self-submitted'],
  ] as const) {
    assert.equal(extensionSafetyUpdatePathIsEvidenceOnly(method, path), true, `${method} ${path}`);
  }

  for (const [method, path] of [
    ['GET', '/profile'],
    ['GET', '/autofill/event'],
    ['GET', '/applications/id/fill-data'],
    ['POST', '/applications/id/manual-submission-start'],
    ['POST', '/applications/id/manual-submission-preflight'],
    ['POST', '/applications/id/submission/extension-start'],
    ['POST', '/applications/id/submission/approve'],
  ] as const) {
    assert.equal(extensionSafetyUpdatePathIsEvidenceOnly(method, path), false, `${method} ${path}`);
  }
});
