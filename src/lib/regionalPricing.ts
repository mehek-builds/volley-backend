import { createHmac, timingSafeEqual } from 'node:crypto';

export type BillingInterval = 'monthly' | 'yearly';
export type PricingBand = 'access' | 'standard' | 'premium';

export type PricingVariant = {
  key: string;
  weightBps: number;
  multiplierBps: number;
};

export type PricingExperiment = {
  id: string;
  enabled: boolean;
  allocationBps: number;
  variants: PricingVariant[];
};

export type PricingOffer = {
  policyVersion: string;
  countryCode: string;
  detectedCountryCode: string | null;
  requestedCountryCode: string | null;
  countryMismatch: boolean;
  band: PricingBand;
  interval: BillingInterval;
  currency: 'USD';
  baseAmountCents: number;
  amountCents: number;
  experimentId: string | null;
  experimentVariant: string;
};

type QuoteTokenPayload = PricingOffer & {
  version: 1;
  subjectId: string;
  issuedAt: number;
  expiresAt: number;
};

export const PRICING_POLICY_VERSION = '2026-07-26.v1';

const BASE_PRICES: Record<PricingBand, Record<BillingInterval, number>> = {
  access: { monthly: 2499, yearly: 23990 },
  standard: { monthly: 4999, yearly: 47988 },
  premium: { monthly: 5999, yearly: 57590 },
};

const PRICE_LIMITS: Record<PricingBand, Record<BillingInterval, [number, number]>> = {
  access: { monthly: [1499, 3999], yearly: [14390, 38390] },
  standard: { monthly: [4000, 5499], yearly: [38400, 52790] },
  premium: { monthly: [5500, 7999], yearly: [52800, 76790] },
};

const PREMIUM_COUNTRIES = new Set([
  'AE', 'AT', 'AU', 'BE', 'CA', 'CH', 'DE', 'DK', 'FI', 'FR', 'GB', 'HK',
  'IE', 'IS', 'JP', 'KR', 'KW', 'LU', 'MC', 'NL', 'NO', 'NZ', 'QA', 'SE',
  'SG', 'US',
]);

const ACCESS_COUNTRIES = new Set([
  'AF', 'AO', 'BD', 'BF', 'BI', 'BJ', 'BO', 'BT', 'CD', 'CF', 'CG', 'CI',
  'CM', 'CV', 'DJ', 'EG', 'ER', 'ET', 'GH', 'GM', 'GN', 'GW', 'HT', 'ID',
  'IN', 'KE', 'KH', 'KM', 'LA', 'LK', 'LR', 'LS', 'MG', 'ML', 'MM', 'MN',
  'MR', 'MW', 'MZ', 'NE', 'NG', 'NP', 'PK', 'PG', 'PH', 'RW', 'SD', 'SL',
  'SN', 'SO', 'SS', 'ST', 'SZ', 'TD', 'TG', 'TJ', 'TL', 'TZ', 'UG', 'UZ',
  'VN', 'YE', 'ZM', 'ZW',
]);

export const SUPPORTED_COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AS', 'AT', 'AU',
  'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ',
  'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA',
  'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO',
  'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN',
  'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT',
  'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE',
  'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW',
  'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV',
  'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN',
  'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS',
  'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC',
  'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR',
  'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TG', 'TH', 'TJ', 'TK',
  'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US',
  'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'XK',
  'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

const SUPPORTED = new Set<string>(SUPPORTED_COUNTRY_CODES);

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && SUPPORTED.has(code) ? code : null;
}

export function pricingBandForCountry(countryCode: string): PricingBand {
  if (PREMIUM_COUNTRIES.has(countryCode)) return 'premium';
  if (ACCESS_COUNTRIES.has(countryCode)) return 'access';
  return 'standard';
}

function bandRank(band: PricingBand): number {
  return band === 'premium' ? 3 : band === 'standard' ? 2 : 1;
}

function higherPricedCountry(first: string | null, second: string | null): string {
  if (!first && !second) return 'ZZ';
  if (!first) return second!;
  if (!second) return first;
  return bandRank(pricingBandForCountry(first)) >= bandRank(pricingBandForCountry(second)) ? first : second;
}

function stableBucket(subjectId: string, scope: string, secret: string): number {
  const digest = createHmac('sha256', secret).update(`${scope}:${subjectId}`).digest();
  return digest.readUInt32BE(0) % 10000;
}

function psychologicalPrice(raw: number, min: number, max: number): number {
  const bounded = Math.max(min, Math.min(max, Math.round(raw)));
  const ending99 = Math.floor(bounded / 100) * 100 + 99;
  return Math.max(min, Math.min(max, ending99));
}

export function parsePricingExperiment(raw = process.env.PRICING_EXPERIMENT_JSON): PricingExperiment | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    const enabled = parsed.enabled === true;
    const allocationBps = Number(parsed.allocation_bps ?? 0);
    const sourceVariants = Array.isArray(parsed.variants) ? parsed.variants : [];
    const variants = sourceVariants.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        key: typeof row.key === 'string' ? row.key.trim() : '',
        weightBps: Number(row.weight_bps),
        multiplierBps: Number(row.multiplier_bps),
      };
    });
    const totalWeight = variants.reduce((sum, variant) => sum + variant.weightBps, 0);
    if (!id || !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) return null;
    if (!Number.isInteger(allocationBps) || allocationBps < 0 || allocationBps > 10000) return null;
    if (variants.length < 2 || variants.some((variant) =>
      !/^[a-zA-Z0-9._-]{1,40}$/.test(variant.key)
      || !Number.isInteger(variant.weightBps)
      || variant.weightBps <= 0
      || !Number.isInteger(variant.multiplierBps)
      || variant.multiplierBps < 7000
      || variant.multiplierBps > 14000
    )) return null;
    if (totalWeight !== 10000 || new Set(variants.map((variant) => variant.key)).size !== variants.length) return null;
    return { id, enabled, allocationBps, variants };
  } catch {
    return null;
  }
}

function assignedVariant(
  subjectId: string,
  experiment: PricingExperiment | null,
  secret: string,
  forcedVariant?: string | null,
): { experimentId: string | null; variant: PricingVariant } {
  const control = { key: 'control', weightBps: 10000, multiplierBps: 10000 };
  if (!experiment || !experiment.enabled) return { experimentId: null, variant: control };
  if (forcedVariant) {
    const found = experiment.variants.find((variant) => variant.key === forcedVariant);
    if (found) return { experimentId: experiment.id, variant: found };
  }
  if (stableBucket(subjectId, `${experiment.id}:allocation`, secret) >= experiment.allocationBps) {
    return { experimentId: experiment.id, variant: control };
  }
  const bucket = stableBucket(subjectId, `${experiment.id}:variant`, secret);
  let ceiling = 0;
  for (const variant of experiment.variants) {
    ceiling += variant.weightBps;
    if (bucket < ceiling) return { experimentId: experiment.id, variant };
  }
  return { experimentId: experiment.id, variant: experiment.variants[experiment.variants.length - 1] };
}

export function resolvePricingOffer(input: {
  subjectId: string;
  detectedCountryCode?: unknown;
  requestedCountryCode?: unknown;
  interval: BillingInterval;
  experiment?: PricingExperiment | null;
  experimentSecret: string;
  forcedVariant?: string | null;
}): PricingOffer {
  const detected = normalizeCountryCode(input.detectedCountryCode);
  const requested = normalizeCountryCode(input.requestedCountryCode);
  const countryMismatch = Boolean(detected && requested && detected !== requested);
  const countryCode = countryMismatch
    ? higherPricedCountry(detected, requested)
    : requested ?? detected ?? 'ZZ';
  let band = countryCode === 'ZZ' ? 'standard' : pricingBandForCountry(countryCode);
  if (band === 'access' && !detected) band = 'standard';

  const baseAmountCents = BASE_PRICES[band][input.interval];
  const assignment = assignedVariant(
    input.subjectId,
    input.experiment ?? null,
    input.experimentSecret,
    input.forcedVariant,
  );
  const [min, max] = PRICE_LIMITS[band][input.interval];
  const amountCents = assignment.variant.multiplierBps === 10000
    ? baseAmountCents
    : psychologicalPrice(baseAmountCents * assignment.variant.multiplierBps / 10000, min, max);

  return {
    policyVersion: PRICING_POLICY_VERSION,
    countryCode,
    detectedCountryCode: detected,
    requestedCountryCode: requested,
    countryMismatch,
    band,
    interval: input.interval,
    currency: 'USD',
    baseAmountCents,
    amountCents,
    experimentId: assignment.experimentId,
    experimentVariant: assignment.variant.key,
  };
}

function quoteSecret(explicit?: string): string | null {
  return explicit?.trim()
    || process.env.PRICING_SIGNING_SECRET?.trim()
    || process.env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim()
    || null;
}

export function signPricingQuote(
  offer: PricingOffer,
  subjectId: string,
  now = new Date(),
  explicitSecret?: string,
): string | null {
  const secret = quoteSecret(explicitSecret);
  if (!secret) return null;
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: QuoteTokenPayload = {
    version: 1,
    subjectId,
    ...offer,
    issuedAt,
    expiresAt: issuedAt + 15 * 60,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyPricingQuote(
  token: unknown,
  now = new Date(),
  explicitSecret?: string,
): QuoteTokenPayload | null {
  const secret = quoteSecret(explicitSecret);
  if (!secret || typeof token !== 'string') return null;
  const [encoded, givenSignature, extra] = token.split('.');
  if (!encoded || !givenSignature || extra) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(encoded).digest('base64url'));
  const given = Buffer.from(givenSignature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as QuoteTokenPayload;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (payload.version !== 1 || payload.expiresAt < nowSeconds || payload.issuedAt > nowSeconds + 60) return null;
    if (!payload.subjectId || payload.policyVersion !== PRICING_POLICY_VERSION) return null;
    if (!normalizeCountryCode(payload.countryCode) && payload.countryCode !== 'ZZ') return null;
    if (!['monthly', 'yearly'].includes(payload.interval)) return null;
    if (!['access', 'standard', 'premium'].includes(payload.band)) return null;
    if (!Number.isInteger(payload.amountCents) || payload.amountCents <= 0) return null;
    return payload;
  } catch {
    return null;
  }
}
