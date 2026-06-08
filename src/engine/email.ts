import { db } from '../db/index';
import { domain_patterns, contacts as contactsTable, companies as companiesTable } from '../db/schema';
import { eq, and, gte } from 'drizzle-orm';
import { renderTopCandidates, renderPattern, orderedPatterns } from './patterns';
import { verifyPrimary, verifySecondary } from './verify';
import { verifyHunter } from './hunter';

export type EmailTier = 'green' | 'amber' | 'blue';
export type EmailStatus = 'verified' | 'likely' | 'linkedin_only' | 'none';
export type EmailSource = 'cache' | 'generated' | 'secondary' | 'apollo' | 'hunter' | 'none';

export interface EmailResolutionResult {
  email: string | null;
  status: EmailStatus;
  tier: EmailTier;
  source: EmailSource;
  verifierRawJson: unknown;
  patternUsed: string | null;
}

interface ContactInput {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
}

interface CompanyInfo {
  size_bucket: string | null;
}

async function learnPattern(
  domain: string,
  pattern: string,
  currentConfirmations = 1
): Promise<void> {
  try {
    const existing = await db
      .select()
      .from(domain_patterns)
      .where(eq(domain_patterns.domain, domain))
      .limit(1);

    if (existing.length > 0) {
      const newConfirmations = (existing[0].confirmations ?? 1) + 1;
      const newConfidence = Math.min(0.99, (existing[0].confidence ?? 0.5) + 0.1);
      await db
        .update(domain_patterns)
        .set({
          pattern,
          confidence: newConfidence,
          confirmations: newConfirmations,
          last_confirmed_at: new Date(),
        })
        .where(eq(domain_patterns.domain, domain));
    } else {
      await db.insert(domain_patterns).values({
        domain,
        pattern,
        confidence: 0.7,
        confirmations: currentConfirmations,
        last_confirmed_at: new Date(),
      });
    }
  } catch (err) {
    console.error('[email] Failed to learn pattern:', err);
  }
}

/**
 * Resolve an email we already have (e.g. a real address from Apollo) rather than generating
 * candidates. When REOON_API_KEY is set we independently verify it; otherwise we trust the
 * provider's own status. This is the path that makes Apollo-sourced contacts come back as
 * genuinely verified (green) instead of best-guess.
 */
export async function resolveKnownEmail(
  email: string,
  providerStatus: string | undefined
): Promise<EmailResolutionResult> {
  // Primary verifier: Hunter. It resolves catch-all domains well and is the cheapest of our
  // providers, so it runs first and short-circuits on a definitive answer.
  if (process.env.HUNTER_API_KEY) {
    const h = await verifyHunter(email);
    if (h.status === 'VALID') {
      return { email, status: 'verified', tier: 'green', source: 'hunter', verifierRawJson: h.raw, patternUsed: null };
    }
    if (h.status === 'INVALID') {
      return { email: null, status: 'none', tier: 'blue', source: 'hunter', verifierRawJson: h.raw, patternUsed: null };
    }
    // CATCH_ALL / UNKNOWN: fall through to Reoon/BounceBan below.
  }

  if (process.env.REOON_API_KEY) {
    const v = await verifyPrimary(email);
    if (v.status === 'VALID') {
      return { email, status: 'verified', tier: 'green', source: 'apollo', verifierRawJson: v.raw, patternUsed: null };
    }
    if (v.status === 'INVALID') {
      return { email: null, status: 'none', tier: 'blue', source: 'apollo', verifierRawJson: v.raw, patternUsed: null };
    }
    // CATCH_ALL / UNKNOWN: Reoon can't decide on catch-all domains. If the provider already
    // calls it verified, trust that (no extra spend). Otherwise use BounceBan, which resolves
    // catch-all addresses, before falling back to the provider's status.
    const providerVerified = providerStatus === 'verified';
    if (!providerVerified && process.env.BOUNCEBAN_API_KEY) {
      const s = await verifySecondary(email);
      if (s.deliverable && s.confidence >= 0.85) {
        return { email, status: 'verified', tier: 'green', source: 'secondary', verifierRawJson: s.raw, patternUsed: null };
      }
      if (s.raw && !s.deliverable && s.confidence === 0) {
        return { email: null, status: 'none', tier: 'blue', source: 'secondary', verifierRawJson: s.raw, patternUsed: null };
      }
    }
  }

  const providerVerified = providerStatus === 'verified';
  return {
    email,
    status: providerVerified ? 'verified' : 'likely',
    tier: providerVerified ? 'green' : 'amber',
    source: 'apollo',
    verifierRawJson: { provider_email_status: providerStatus ?? null },
    patternUsed: null,
  };
}

export async function resolveEmail(
  contact: ContactInput,
  company: CompanyInfo
): Promise<EmailResolutionResult> {
  const domain = contact.company_domain;
  const firstName = contact.first_name ?? '';
  const lastName = contact.last_name ?? '';

  if (!domain || !firstName || !lastName) {
    return {
      email: null,
      status: 'none',
      tier: 'blue',
      source: 'none',
      verifierRawJson: null,
      patternUsed: null,
    };
  }

  const name = { first: firstName, last: lastName };

  // Step 1: Check domain_patterns cache with confidence >= 0.8
  const cachedPatterns = await db
    .select()
    .from(domain_patterns)
    .where(and(eq(domain_patterns.domain, domain), gte(domain_patterns.confidence, 0.8)))
    .limit(1);

  if (cachedPatterns.length > 0) {
    const cached = cachedPatterns[0];
    const candidateEmail = renderPattern(cached.pattern, name, domain);
    const verifyResult = await verifyPrimary(candidateEmail);

    if (verifyResult.status === 'VALID') {
      return {
        email: candidateEmail,
        status: 'verified',
        tier: 'green',
        source: 'cache',
        verifierRawJson: verifyResult.raw,
        patternUsed: cached.pattern,
      };
    }

    if (verifyResult.status === 'CATCH_ALL') {
      // Domain is catch-all - return amber best-guess
      return {
        email: candidateEmail,
        status: 'likely',
        tier: 'amber',
        source: 'cache',
        verifierRawJson: verifyResult.raw,
        patternUsed: cached.pattern,
      };
    }
  }

  // Step 2: Generate candidates by company size prior
  const candidates = renderTopCandidates(name, domain, company.size_bucket, 6);

  // Step 3: Check if catch-all by verifying first candidate
  if (candidates.length > 0) {
    const catchAllCheck = await verifyPrimary(candidates[0]);
    if (catchAllCheck.isCatchAll) {
      // Domain is catch-all - return amber with best-guess pattern
      const patterns = orderedPatterns(company.size_bucket);
      return {
        email: candidates[0],
        status: 'likely',
        tier: 'amber',
        source: 'generated',
        verifierRawJson: catchAllCheck.raw,
        patternUsed: patterns[0] ?? null,
      };
    }
  }

  // Step 4: Verify candidates in order with primary verifier
  const patternTemplates = orderedPatterns(company.size_bucket);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const result = await verifyPrimary(candidate);

    if (result.status === 'VALID') {
      const pattern = patternTemplates[i] ?? '';
      await learnPattern(domain, pattern);
      return {
        email: candidate,
        status: 'verified',
        tier: 'green',
        source: 'generated',
        verifierRawJson: result.raw,
        patternUsed: pattern,
      };
    }

    if (result.status === 'CATCH_ALL') {
      break;
    }
  }

  // Step 5: Secondary pass with BounceBan
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const result = await verifySecondary(candidate);

    if (result.deliverable && result.confidence >= 0.85) {
      const pattern = patternTemplates[i] ?? '';
      await learnPattern(domain, pattern);
      return {
        email: candidate,
        status: 'verified',
        tier: 'green',
        source: 'secondary',
        verifierRawJson: result.raw,
        patternUsed: pattern,
      };
    }
  }

  // Step 6: Fallback - LinkedIn only (blue)
  if (!process.env.REOON_API_KEY) {
    // API keys missing - return amber with a note
    return {
      email: candidates[0] ?? null,
      status: 'likely',
      tier: 'amber',
      source: 'generated',
      verifierRawJson: { note: 'Verification APIs not configured - best-guess pattern used' },
      patternUsed: patternTemplates[0] ?? null,
    };
  }

  return {
    email: null,
    status: 'linkedin_only',
    tier: 'blue',
    source: 'none',
    verifierRawJson: null,
    patternUsed: null,
  };
}
