import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCountryCode,
  parsePricingExperiment,
  pricingBandForCountry,
  resolvePricingOffer,
  signPricingQuote,
  verifyPricingQuote,
} from './regionalPricing';

const experiment = parsePricingExperiment(JSON.stringify({
  id: 'price-2026-08',
  enabled: true,
  allocation_bps: 10000,
  variants: [
    { key: 'control', weight_bps: 5000, multiplier_bps: 10000 },
    { key: 'stretch', weight_bps: 5000, multiplier_bps: 12000 },
  ],
}));

describe('regional pricing policy', () => {
  test('maps representative countries and rejects malformed codes', () => {
    assert.equal(pricingBandForCountry('US'), 'premium');
    assert.equal(pricingBandForCountry('IN'), 'access');
    assert.equal(pricingBandForCountry('BR'), 'standard');
    assert.equal(normalizeCountryCode(' ae '), 'AE');
    assert.equal(normalizeCountryCode('XX'), null);
    assert.equal(normalizeCountryCode('USA'), null);
  });

  test('charges the higher band when detected and requested countries conflict', () => {
    const offer = resolvePricingOffer({
      subjectId: 'user-1',
      detectedCountryCode: 'US',
      requestedCountryCode: 'IN',
      interval: 'monthly',
      experimentSecret: 'secret',
    });
    assert.equal(offer.countryMismatch, true);
    assert.equal(offer.countryCode, 'US');
    assert.equal(offer.band, 'premium');
    assert.equal(offer.amountCents, 5999);
  });

  test('does not grant an access price from an uncorroborated manual selection', () => {
    const offer = resolvePricingOffer({
      subjectId: 'user-2',
      requestedCountryCode: 'IN',
      interval: 'monthly',
      experimentSecret: 'secret',
    });
    assert.equal(offer.band, 'standard');
    assert.equal(offer.amountCents, 4999);
  });

  test('keeps experiment assignment deterministic and inside each band', () => {
    assert.ok(experiment);
    const first = resolvePricingOffer({
      subjectId: 'stable-user', detectedCountryCode: 'IN', requestedCountryCode: 'IN',
      interval: 'monthly', experiment, experimentSecret: 'secret',
    });
    const second = resolvePricingOffer({
      subjectId: 'stable-user', detectedCountryCode: 'IN', requestedCountryCode: 'IN',
      interval: 'monthly', experiment, experimentSecret: 'secret',
    });
    assert.equal(first.experimentVariant, second.experimentVariant);
    assert.equal(first.amountCents, second.amountCents);
    assert.ok(first.amountCents >= 1499 && first.amountCents <= 3999);
  });

  test('rejects experiments with invalid weights or unsafe multipliers', () => {
    assert.equal(parsePricingExperiment('{"id":"x","enabled":true,"allocation_bps":10000,"variants":[]}'), null);
    assert.equal(parsePricingExperiment(JSON.stringify({
      id: 'x', enabled: true, allocation_bps: 10000,
      variants: [
        { key: 'a', weight_bps: 5000, multiplier_bps: 5000 },
        { key: 'b', weight_bps: 4000, multiplier_bps: 10000 },
      ],
    })), null);
  });
});

describe('signed pricing quotes', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  const offer = resolvePricingOffer({
    subjectId: 'subject-1', detectedCountryCode: 'AE', requestedCountryCode: 'AE',
    interval: 'yearly', experimentSecret: 'experiment-secret',
  });

  test('round trips an untampered quote', () => {
    const token = signPricingQuote(offer, 'subject-1', now, 'quote-secret');
    const parsed = verifyPricingQuote(token, new Date('2026-07-26T12:10:00.000Z'), 'quote-secret');
    assert.equal(parsed?.subjectId, 'subject-1');
    assert.equal(parsed?.amountCents, 57590);
  });

  test('rejects tampered and expired quotes', () => {
    const token = signPricingQuote(offer, 'subject-1', now, 'quote-secret')!;
    assert.equal(verifyPricingQuote(`${token}x`, now, 'quote-secret'), null);
    assert.equal(verifyPricingQuote(token, new Date('2026-07-26T12:16:00.000Z'), 'quote-secret'), null);
  });
});
