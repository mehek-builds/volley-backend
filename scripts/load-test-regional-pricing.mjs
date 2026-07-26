import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  parsePricingExperiment,
  resolvePricingOffer,
  signPricingQuote,
  verifyPricingQuote,
} from '../src/lib/regionalPricing.ts';

const iterations = Number(process.env.PRICING_LOAD_ITERATIONS ?? 250_000);
const secret = 'load-test-regional-pricing-secret-32-chars';
const countries = ['US', 'AE', 'GB', 'DE', 'JP', 'BR', 'MX', 'ZA', 'IN', 'NG', 'PH', 'VN'];
const experiment = parsePricingExperiment(JSON.stringify({
  id: 'load-test-wtp',
  enabled: true,
  allocation_bps: 5000,
  variants: [
    { key: 'control', weight_bps: 5000, multiplier_bps: 10000 },
    { key: 'plus10', weight_bps: 5000, multiplier_bps: 11000 },
  ],
}));
assert.ok(experiment);

const counts = { access: 0, standard: 0, premium: 0 };
const started = performance.now();
for (let index = 0; index < iterations; index += 1) {
  const country = countries[index % countries.length];
  const interval = index % 2 === 0 ? 'monthly' : 'yearly';
  const subjectId = `load-subject-${index}`;
  const offer = resolvePricingOffer({
    subjectId,
    detectedCountryCode: country,
    requestedCountryCode: country,
    interval,
    experiment,
    experimentSecret: secret,
  });
  counts[offer.band] += 1;
  assert.ok(offer.amountCents > 0);
  if (index % 1000 === 0) {
    const token = signPricingQuote(offer, subjectId, new Date(), secret);
    assert.ok(token);
    assert.equal(verifyPricingQuote(token, new Date(), secret)?.amountCents, offer.amountCents);
  }
}
const elapsedMs = performance.now() - started;
assert.equal(counts.access + counts.standard + counts.premium, iterations);
assert.ok(counts.access > 0 && counts.standard > 0 && counts.premium > 0);

console.log(JSON.stringify({
  iterations,
  elapsed_ms: Math.round(elapsedMs),
  decisions_per_second: Math.round(iterations / (elapsedMs / 1000)),
  counts,
}));
