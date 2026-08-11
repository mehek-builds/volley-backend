import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { application_profile } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { encryptField, decryptField, looksEncrypted, FieldDecryptError } from '../lib/fieldCrypto';
import { isUndefinedColumnError, selectApplicationProfileRow, upsertApplicationProfile, type ApplicationProfileRow } from '../lib/applicationFacts';
import {
  countryWorkEligibilityListSchema,
  legacyUsProjection,
  normalizeCountryWorkEligibility,
} from '../lib/workEligibility';
import { persistProfileWithCountryEligibility } from '../lib/countryEligibilityPersistence';

// Fields sensitive enough to encrypt at rest per PRD-v2 Section 4: phone/address/
// work-authorization status. Links and referral_source are not identity-sensitive
// in the same way and stay plaintext so they remain easily queryable later.
// Exported so /profile/harvest encrypts the same set: two copies of this list would drift, and
// the failure mode of drift is a sensitive value written to the DB in plaintext.
export const ENCRYPTED_FIELDS = [
  'phone',
  'address_city',
  'address_state',
  'address_zip',
  'address_country',
  'citizenship',
  'availability_date',
  'desired_salary',
  'date_of_birth',
  // Academic record (R-005). Encrypted with the identity-sensitive set rather than left plaintext
  // with the links: a specific GPA is a real record about a real person. gpa_scale and major stay
  // plaintext - a scale is meaningless on its own, and a major is no more sensitive than school,
  // which profiles.parsed_json already stores in the clear.
  'gpa',
] as const;
// availability_term is deliberately absent, though availability_date is here. The bar is identity
// sensitivity, not "everything on the profile": links, referral_source_default, gpa and major are
// all plaintext too. "14 weeks" says nothing about who she is, where she lives or what she earns,
// and leaving it queryable is worth more than encrypting a duration. A date is different: combined
// with the rest it is a movement fact about a person.

// Every column is nullable in the DB (application_profile has no .notNull() fields), and
// GET echoes back null for anything unset. The client round-trips the fetched profile
// verbatim on save, so every field here must accept null, not just undefined - `.optional()`
// alone rejects null and 400s on every save-after-load.
//
// Exported for the round-trip test. The failure mode it pins: a column declared in schema.ts with
// no line here is stripped by zod SILENTLY, so PUT discards the value and still returns 200 - the
// client believes a write that never happened. Every new column must land in both places at once.
export const bodySchema = z.object({
  phone: z.string().nullable().optional(),
  address_city: z.string().nullable().optional(),
  address_state: z.string().nullable().optional(),
  address_zip: z.string().nullable().optional(),
  address_country: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  github_url: z.string().nullable().optional(),
  portfolio_url: z.string().nullable().optional(),
  citizenship: z.string().nullable().optional(),
  work_authorized: z.boolean().nullable().optional(),
  needs_sponsorship: z.boolean().nullable().optional(),
  work_eligibility_by_country: countryWorkEligibilityListSchema.nullable().optional(),
  availability_date: z.string().nullable().optional(),
  availability_term: z.string().nullable().optional(),
  desired_salary: z.string().nullable().optional(),
  // The unit `desired_salary` is in. A figure without it cannot be filled honestly onto a
  // posting in another currency, so the adapters require both or neither.
  desired_salary_currency: z.string().nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  // Academic record (R-005). gpa and gpa_scale are separate on purpose: "3.89" says nothing without
  // "4.0", and a form asking for a UK percentage cannot be answered honestly without knowing the
  // scale the number was earned on.
  gpa: z.string().nullable().optional(),
  gpa_scale: z.string().nullable().optional(),
  major: z.string().nullable().optional(),
  // Fluent languages, a string[] the student enumerated themselves (see schema.ts for why the
  // declared list is the authority). Plaintext, so deliberately NOT in ENCRYPTED_FIELDS above -
  // and being an array, encryptRow's typeof-string guard would skip it even if someone added it
  // there by mistake.
  languages: z.array(z.string()).nullable().optional(),
  // Only ever set if the student explicitly opts in (PRD-v2 Section 4B); absent/null
  // means every autofill selects "Decline to Self-Identify" where that option exists.
  eeo_prefs: z.record(z.string()).nullable().optional(),
  referral_source_default: z.string().nullable().optional(),

  /* ---- application facts asked once in onboarding ----
   * See schema.ts for why each of these exists and what null means. Plaintext, so none of them is
   * in ENCRYPTED_FIELDS above. Every one accepts null for the round-trip reason in the comment at
   * the top of this schema: the client re-sends the whole fetched profile on save.
   */
  pronouns: z.string().nullable().optional(),
  legal_first_name: z.string().nullable().optional(),
  preferred_first_name: z.string().nullable().optional(),
  high_school_grad_date: z.string().nullable().optional(),
  // When the current programme started, as a month and year ("August 2024"). See schema.ts for why
  // this cannot be derived from high_school_grad_date or from the graduation date.
  education_start_date: z.string().nullable().optional(),
  // A string[] of employers previously applied to. [] is a real answer ("none"), which is why the
  // array is not collapsed to a boolean here or anywhere downstream.
  prior_application_employers: z.array(z.string()).nullable().optional(),
  has_outstanding_offers: z.boolean().nullable().optional(),
  outstanding_offer_details: z.string().nullable().optional(),
  military_service: z.string().nullable().optional(),
  politically_exposed: z.string().nullable().optional(),
  politically_exposed_family: z.string().nullable().optional(),
  // Constrained rather than free text: the resolver turns it into Yes/No answers on real forms, and
  // an unrecognised string would silently mean "never asked" instead of failing the save.
  advanced_study_plan: z.enum(['no', 'considering', 'committed']).nullable().optional(),
  attest_truthful_information: z.boolean().nullable().optional(),
  accept_privacy_notices: z.boolean().nullable().optional(),

  /* ---- where she will work from ----
   * Constrained for the same reason advanced_study_plan is: the resolver turns these into Yes and
   * No on real employer forms, so an unrecognised string must fail the save rather than read back
   * as "never asked" and quietly stop answering. onsite_locations is her own free text (the metro
   * as she would type it), ordered most-preferred first, and [] is a real answer meaning "no office
   * works for me" rather than "never asked" - which is why it is not collapsed to a null.
   */
  onsite_commitment: z.enum(['anywhere', 'listed_locations', 'no']).nullable().optional(),
  onsite_locations: z.array(z.string()).nullable().optional(),
  relocation_willingness: z.enum(['yes', 'no']).nullable().optional(),

  /* ---- when the internship can run: the scoped, expiring window ----
   *
   * SHAPE-CHECKED HERE, MEANING-CHECKED IN lib/availabilityWindow.ts. The two dates and the expiry
   * must be ISO YYYY-MM-DD and the cycle must be a season and a year, because a value that does not
   * parse is indistinguishable from "never asked" once it reaches the resolver - it would save with
   * a 200 and then silently stop answering, which is the worst of the three outcomes. Rejecting the
   * save is how the student finds out. Everything about whether the window is coherent, still live,
   * and about THIS posting stays in one place downstream. */
  availability_window_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  availability_window_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  availability_cycle: z.string().regex(/^(?:Spring|Summer|Fall|Winter) (?:20)\d{2}$/).nullable().optional(),
  availability_valid_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),

  /* ---- standardized test scores ----
   * See schema.ts for the 8-packets-each measurement behind all three, and for why that count is
   * not on its own the argument for the columns. Plaintext, so none is in
   * ENCRYPTED_FIELDS above: they are read off the RAW row by lib/applicationFacts.ts, and a
   * decrypt step on that path would hand ciphertext to an employer's form.
   *
   * The TYPE is constrained and the SCORES are free text, deliberately. The type is turned into an
   * answer on a closed list by the resolver, so an unrecognised string must fail the save rather
   * than read back as "never asked" - the same rule advanced_study_plan follows above. The scores
   * cannot be constrained the same way: "1520", "34" and "1520 (superscored)" are all real answers
   * and a numeric check would reject the third, which is the one a student is most likely to type.
   * Trimmed, non-empty; an empty string is not a score, and null is the only way to say "not
   * answered". */
  standardized_test_type: z.enum(['SAT', 'ACT', 'Both', 'None']).nullable().optional(),
  sat_score: z.string().trim().min(1).nullable().optional(),
  act_score: z.string().trim().min(1).nullable().optional(),
});

/* The consent timestamp is SERVER-SET, never taken from the body, which is why it has no line
 * above. It is the evidence that the two attestation booleans were granted, and evidence a client
 * can post is not evidence. Same rule automationConsentValues follows for the users.* permissions. */
export function attestationConsentStamp(body: z.infer<typeof bodySchema>): { application_attestations_consented_at: Date } | Record<string, never> {
  const touched = body.attest_truthful_information !== undefined || body.accept_privacy_notices !== undefined;
  return touched ? { application_attestations_consented_at: new Date() } : {};
}

export function applicationProfileWriteValues(body: z.infer<typeof bodySchema>) {
  const row: Record<string, unknown> = { ...body };
  if (Array.isArray(body.work_eligibility_by_country)) {
    const records = body.work_eligibility_by_country;
    // The whole declaration is one authenticated envelope. Encrypting only type and expiry would
    // still expose the same immigration claim through country and authorization booleans.
    row.work_eligibility_by_country = encryptField(JSON.stringify(records));
    Object.assign(row, legacyUsProjection(records));
  } else {
    // Current extension builds round-trip the legacy scalar-only profile. Keep those writes until
    // every installed client sends the scoped list. A null scoped key means "client has no scoped
    // value", not "erase the old booleans". Once a list is present it is authoritative and the
    // scalars above are derived from it, so stale client booleans cannot override a country row.
    delete row.work_eligibility_by_country;
  }
  for (const field of ENCRYPTED_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.length > 0) {
      row[field] = encryptField(value);
    }
  }
  return row;
}

// R-021: a value that fails to decrypt is NOT automatically legacy plaintext.
//
// The catch that used to sit here assumed it was, and passed the raw value straight through. So a
// missing or rotated ENCRYPTION_KEY did not fail: it quietly served base64 ciphertext, which the
// extension then typed into real job applications. Caught live on Proxima Fusion filling the
// required "When are you available to start?" field, with auto-submit already proven to fire.
//
// The two cases are now told apart by shape. A value that does not look like our envelope is
// genuinely legacy plaintext and passes through exactly as before. A value that DOES look like our
// envelope but will not decrypt means the key is wrong, rotated or gone, which is a config error
// about the server, not data the student can fix.
//
// That case throws, and the route turns it into a 500. It deliberately does NOT degrade to "null
// the bad field and serve the rest", even though a blank field would be safe to fill: the client
// round-trips the fetched profile verbatim on save (see bodySchema above) and PUT writes it back
// with `set`, so a served null would be saved straight over the still-encrypted column and destroy
// the only copy of the data. Refusing to serve keeps a recoverable problem recoverable.
//
// Exported for GET /account/export, which has to hand back the same decrypted view this route
// serves - an export that returned ciphertext would not be an export. It inherits the throw above
// deliberately: an export that silently handed back base64 would be worse here than anywhere,
// since the student is being told this file IS their data.
export function decryptRow(row: ApplicationProfileRow) {
  const out: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const value = out[field];
    if (typeof value === 'string' && value.length > 0 && looksEncrypted(value)) {
      out[field] = decryptField(value); // throws FieldDecryptError on a wrong or missing key
    }
  }
  const storedEligibility = out.work_eligibility_by_country;
  if (typeof storedEligibility === 'string') {
    try {
      const plaintext = looksEncrypted(storedEligibility) ? decryptField(storedEligibility) : storedEligibility;
      out.work_eligibility_by_country = normalizeCountryWorkEligibility(JSON.parse(plaintext)) ?? [];
    } catch (error) {
      if (error instanceof FieldDecryptError) throw error;
      // Corrupt or duplicate scoped data is authoritative but unusable. Never synthesize a hidden
      // scoped key from the legacy scalars in this path: scalar-only extension GET-edit-PUT must
      // round-trip exactly the contract it understands.
      out.work_eligibility_by_country = [];
    }
  }
  return out;
}

// Serve a profile row, or refuse loudly if it cannot be decrypted. Shared by GET and PUT so the
// two cannot drift: PUT re-reads and returns the row too, and would otherwise emit ciphertext by
// the same route the GET no longer does.
function sendProfile(
  fastify: FastifyInstance,
  reply: FastifyReply,
  row: ApplicationProfileRow,
  userId: string,
) {
  try {
    return reply.status(200).send(decryptRow(row));
  } catch (err) {
    if (err instanceof FieldDecryptError) {
      fastify.log.error(
        { err, userId },
        'ENCRYPTION_KEY cannot decrypt stored application_profile values. Refusing to serve the profile rather than emit ciphertext into an application (R-021). Check that ENCRYPTION_KEY matches the one the rows were written with.',
      );
      return reply.status(500).send({
        error:
          'Your saved details could not be read on the server. This is a configuration problem on our side, not a problem with your data, and re-entering it will not help. Please contact support.',
      });
    }
    throw err;
  }
}

export async function applicationProfileRoutes(fastify: FastifyInstance) {
  fastify.get('/profile/application', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    // Tolerant read: the facts migration is run by hand and a merge is a deploy, so this code can
    // be live against a database that does not have those columns yet. See lib/applicationFacts.ts.
    const row = await selectApplicationProfileRow(userId);
    if (!row) {
      return reply.status(404).send({ error: 'Application profile not found' });
    }
    return sendProfile(fastify, reply, row, userId);
  });

  fastify.put('/profile/application', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const encrypted = { ...applicationProfileWriteValues(body), ...attestationConsentStamp(body) };

    try {
      const scopedRecords = body.work_eligibility_by_country;
      /* No partial-save branch here any more, and there never really was one. upsertApplicationProfile
         used to report `droppedFactColumns` so this handler could warn an operator that the deploy
         was ahead of the migration. That flag could never be true: the retry behind it stripped keys
         from the payload while Drizzle went on naming every declared column in the INSERT, so the
         second attempt raised the same 42703 and threw. The warning below it was unreachable code
         guarding an outcome that never happened. See lib/applicationFacts.ts.

         An unmigrated column now surfaces as the 500 in the catch below, which is what it always
         actually did. The migration is a hard prerequisite for writes: run it before the deploy. */
      if (Array.isArray(scopedRecords)) {
        await persistProfileWithCountryEligibility(userId, encrypted, scopedRecords);
      } else {
        await upsertApplicationProfile(userId, encrypted);
      }
    } catch (err) {
      if (Array.isArray(body.work_eligibility_by_country) && isUndefinedColumnError(err)) {
        return reply.status(503).send({ error: 'Country work eligibility is being enabled. Try again shortly.' });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save application profile' });
    }

    const row = await selectApplicationProfileRow(userId);
    if (!row) return reply.status(500).send({ error: 'Failed to save application profile' });
    return sendProfile(fastify, reply, row, userId);
  });
}
