import { repairMissingSubmissionConfirmation } from '../src/lib/submissionConfirmationRepair';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// Backfilled attempt ids are deterministic hashes shaped like UUIDs without RFC version bits.
const LEGACY_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const userId = valueAfter('--user-id');
const applicationId = valueAfter('--application-id');
const legacyAttemptId = valueAfter('--legacy-attempt-id');
const apply = process.argv.includes('--apply');

if (!userId || !UUID.test(userId) || !applicationId || !UUID.test(applicationId)
  || (legacyAttemptId !== null && !LEGACY_ATTEMPT_ID.test(legacyAttemptId))) {
  console.error('Usage: npx tsx scripts/repair-submission-confirmation.mts --user-id UUID --application-id UUID [--legacy-attempt-id ATTEMPT] [--apply]');
  process.exitCode = 2;
} else {
  const result = await repairMissingSubmissionConfirmation({
    userId,
    applicationId,
    ...(legacyAttemptId ? { legacyAttemptId } : {}),
    dryRun: !apply,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'refused') process.exitCode = 1;
}
