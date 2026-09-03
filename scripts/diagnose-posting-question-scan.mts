/* Reproduce one posting-question scan with the service's own provider credentials, so a stored
 * `failed` row can be explained by the actual error instead of guessed at from the log tail.
 * Read-only against the employer's page exactly like the route (no fills, no uploads); run under
 * `railway run --service litos-api -- npx tsx scripts/diagnose-posting-question-scan.mts <url> <portal>`.
 */

import { scanPostingQuestions, type PostingTarget } from '../src/routes/postingQuestions.ts';

const [applyUrl, portal] = process.argv.slice(2);
if (!applyUrl || !portal) {
  console.error('Usage: diagnose-posting-question-scan.mts <apply-url> <portal>');
  process.exit(2);
}

const target: PostingTarget = {
  applyUrl,
  portal: portal as PostingTarget['portal'],
  company: 'Diagnostic',
  title: 'Diagnostic',
  description: '',
  location: null,
};

const startedAt = Date.now();
try {
  const result = await scanPostingQuestions(target);
  console.log(`status=${result.status} questions=${result.questions.length} blockers=${result.metadata_blockers.length} elapsed_ms=${Date.now() - startedAt}`);
  for (const blocker of result.metadata_blockers.slice(0, 5)) console.log('blocker:', JSON.stringify(blocker).slice(0, 200));
} catch (error) {
  console.error(`scan threw after ${Date.now() - startedAt}ms:`, (error as Error)?.name, String((error as Error)?.message ?? error).slice(0, 600));
}
process.exit(0);
