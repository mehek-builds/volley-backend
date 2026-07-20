import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, PRODUCT_NAME, publicProductConfig } from './product';

test('publishes the canonical Litos product contract', () => {
  const config = publicProductConfig();
  assert.equal(PRODUCT_NAME, 'Litos');
  assert.equal(API_VERSION, '1');
  assert.equal(config.product.name, 'Litos');
  assert.match(config.product.links.install, /chromewebstore\.google\.com/);
  assert.equal(config.api.compatibility.extension.minimum, '0.4.1');
});
