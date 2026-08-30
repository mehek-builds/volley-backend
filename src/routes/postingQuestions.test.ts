import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MANAGED_DISCOVERY_ROLE_CAPABILITY,
  type ManagedBrowserAction,
  type ManagedBrowserResult,
} from '../lib/browserbase';
import {
  MANAGED_ACTION_LIMIT,
  buildManagedPrescriptActions,
  buildManagedDiscoveryActions,
} from '../lib/portalSubmission';
import { resolvePrescript, type PostingQuestion } from '../lib/postingQuestions';
import { prescriptResponse, scanPostingQuestions, type PostingTarget } from './postingQuestions';

const ROUTE = readFileSync('src/routes/postingQuestions.ts', 'utf8');

test('the pre-script scan reads the form and does not touch it', () => {
  const actions = buildManagedPrescriptActions('greenhouse');
  const types = new Set(actions.map((action) => action.type));
  // Nothing is typed, nothing is uploaded, nothing is submitted. This run can happen before she has
  // decided to apply at all, and some boards save a partial application from a fill.
  assert.ok(!types.has('fill'), 'a pre-script scan must not fill anything');
  assert.ok(!types.has('fillByLabelText'));
  assert.ok(!types.has('upload'), 'a pre-script scan must not upload her resume');
  assert.ok(types.has('discover'));
  // The option probes are the reason a closed list comes back with real choices instead of a guess.
  assert.ok(actions.some((action) => action.label?.startsWith('option_probe_open:')));
  assert.ok(actions.some((action) => action.label?.startsWith('options:')));
});

test('the authenticated response containing saved values is never cacheable', () => {
  assert.match(ROUTE, /reply\.header\('Cache-Control', 'private, no-store'\)/);
});

test('the read-only scan is a fraction of the submission-time discovery pass', () => {
  const prescript = buildManagedPrescriptActions('greenhouse');
  // buildManagedDiscoveryActions trims itself to a 120-action ceiling and lands near it, because it
  // is also doing the fixed-field fills the submission needs anyway. This one only reads.
  assert.ok(prescript.length <= 40, `expected a short read-only list, got ${prescript.length}`);
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  } as unknown as Parameters<typeof buildManagedDiscoveryActions>[1];
  assert.ok(prescript.length < buildManagedDiscoveryActions('greenhouse', packet).length);
});

test('a portal with no react-select comboboxes costs one action', () => {
  assert.deepEqual(buildManagedPrescriptActions('lever').map((action) => action.type), ['discover']);
});

test('dynamic role probing stays off unless this exact Stratus result advertises the role wire', () => {
  assert.match(ROUTE, /const discoveryRoleCapability = managedResultSupportsDiscoveryRole\(result\)/);
  assert.match(ROUTE, /const discoveredForOptionProbe = discoveredQuestionsForExactOptionProbe\(discoveredRaw\)/);
  assert.match(ROUTE, /buildManagedDiscoveredOptionProbeBatches\([\s\S]{0,300}discoveryRoleCapability/);
  assert.match(ROUTE, /managedOptionProbeAnalysis\([\s\S]{0,300}discoveryRoleCapability/);
});

test('the posting scan executes every bounded option-probe batch', async () => {
  const discovered = Array.from({ length: 25 }, (_, index) => {
    const controlId = `question_8${String(index).padStart(7, '0')}`;
    return {
      label: `Question ${index + 1}*`,
      selector: `#${controlId}`,
      inputType: 'text',
      role: 'combobox',
      required: true,
      maxLength: null,
    };
  });
  const calls: ManagedBrowserAction[][] = [];
  const browserRunner = async (
    _url: string,
    actions: ManagedBrowserAction[],
  ): Promise<ManagedBrowserResult> => {
    calls.push(actions);
    if (calls.length === 1) {
      return {
        title: 'Application',
        url: responseTarget.applyUrl,
        text: '',
        capabilities: [MANAGED_DISCOVERY_ROLE_CAPABILITY],
        discovered,
      };
    }
    return {
      title: 'Application',
      url: responseTarget.applyUrl,
      text: '',
      extracted: actions.flatMap((action) => {
        if (action.type !== 'extract') return [];
        const controlId = action.label?.startsWith('closed_control:')
          ? action.label.slice('closed_control:'.length)
          : action.label?.startsWith('options:')
            ? action.label.slice('options:'.length)
            : null;
        if (!controlId || !action.selector) return [];
        return [{
          selector: action.selector,
          label: action.label,
          value: action.label?.startsWith('closed_control:') ? controlId : 'Yes\nNo',
        }];
      }),
    };
  };

  const result = await scanPostingQuestions(responseTarget, browserRunner);

  assert.equal(calls.length, 3, 'one discovery plus two option-probe batches must run');
  assert.equal(calls.slice(1).every((actions) => actions.length <= MANAGED_ACTION_LIMIT), true);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.metadata_blockers, []);
  assert.equal(result.questions.length, 25);
  assert.equal(result.questions.every((question) => question.options?.join('|') === 'Yes|No'), true);
});

test('the scan asks for no screenshot', () => {
  // runManagedBrowser renders a full-page PNG by default and nothing on this path would look at it.
  assert.match(ROUTE, /browserRunner\(target\.applyUrl, buildManagedPrescriptActions\(portal\), \{ screenshot: false \}\)/);
  assert.match(ROUTE, /browserRunner\(target\.applyUrl, actions, \{ screenshot: false \}\)/);
});

test('a scan runs only on a cache miss, and only behind an hourly ceiling', () => {
  assert.match(ROUTE, /if \(!postingQuestionsAreFresh\(stored, target\.applyUrl\)\)/);
  const missBranch = ROUTE.slice(ROUTE.indexOf('if (!postingQuestionsAreFresh('), ROUTE.indexOf('const resolution = await resolveFor('));
  assert.match(missBranch, /allowHourly\(userId, 'postingQuestions'/);
  assert.match(missBranch, /scanPostingQuestions\(target\)/);
  // A scan that throws must not empty a cache that was merely stale.
  assert.match(missBranch, /Keep whatever was cached/);
});

test('a page that produced no controls is stored as a result, not as an empty form', () => {
  // Otherwise the next applicant on the same posting is told this form asks nothing, for a
  // fortnight, on the strength of one page that would not load.
  assert.match(ROUTE, /postingQuestionInventoryStatus\(inventory\)/);
  assert.doesNotMatch(ROUTE, /questions\.length > 0 \? 'ok'/);
});

test('incomplete exact metadata is persisted and returned as a typed blocker', () => {
  assert.match(ROUTE, /questionMetadataBlockersForOptionProbeFailures\([\s\S]{0,200}optionProbe\.failures/);
  assert.match(ROUTE, /!optionProbe\.failedIds\.has\(controlId\)/);
  assert.match(ROUTE, /storedPostingQuestionInventory\(questions, metadataBlockers\)/);
  assert.match(ROUTE, /readStoredPostingQuestionInventory\(row\.questions\)/);
  assert.match(ROUTE, /const measuredStatus = postingQuestionInventoryStatus\(inventory\)/);
  assert.match(ROUTE, /storedStatus === 'ok' && measuredStatus === 'metadata_incomplete'/);
  const response = ROUTE.slice(ROUTE.indexOf('function prescriptResponse('));
  assert.match(response, /metadata_blockers: responseMetadataBlockers/);
  assert.match(response, /status === 'ok' && responseMetadataBlockers\.length > 0/);
});

test('a missing table degrades to "nothing cached" rather than a 500', () => {
  // On Vercel a merge is a deploy, so this code can be live before its migration has run.
  const missingRelation = ROUTE.split("'42P01'").length - 1;
  assert.ok(missingRelation >= 2, 'both the read and the write must tolerate a missing table');
});

test('the response lists only the questions that need her, and exposes review evidence for the rest', () => {
  const response = ROUTE.slice(ROUTE.indexOf('function prescriptResponse('));
  assert.match(response, /ask: resolution\.ask\.map/);
  assert.match(response, /filled_answers: filledAnswers/);
  assert.match(response, /already_answered: filledAnswers\.length/);
  // The answer travelling to the client for an ask is either blank or something she typed herself.
  // Nothing on this endpoint drafts, and nothing infers.
  assert.doesNotMatch(ROUTE, /draftApplicationAnswer/);
});

const responseTarget: PostingTarget = {
  applyUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
  portal: 'greenhouse',
  company: 'Example',
  title: 'Software Engineering Intern',
  description: 'Build reliable systems.',
  location: 'Chicago, Illinois',
};

test('the DGA wire response exposes a typed blocker and never invents a question', () => {
  const blocker = {
    kind: 'missing_question_text' as const,
    required: true,
    portal_input_type: 'textarea',
    control_id: 'dga_response',
    portal_selector: '#dga_response',
  };
  const response = prescriptResponse(
    '00000000-0000-4000-8000-000000000001',
    { ...responseTarget, portal: 'lever', company: 'DGA', applyUrl: 'https://jobs.lever.co/dga/abc' },
    [],
    [blocker],
    'metadata_incomplete',
    new Date('2026-08-23T12:00:00.000Z'),
    true,
    { questions: [], ask: [], metadata_blockers: [] },
  );

  assert.equal(response.discovery_status, 'metadata_incomplete');
  assert.deepEqual(response.metadata_blockers, [blocker]);
  assert.deepEqual(response.ask, []);
  assert.equal(response.question_count, 0);
});

test('the Akuna and Jump wire responses carry exact employer choices to the dashboard', () => {
  const cases = [{
    company: 'Akuna',
    question: 'Have you ever applied to a full time or internship position with Akuna in the past?',
  }, {
    company: 'Jump Trading',
    question: 'Are you currently subject to a restrictive covenant, non-compete, or notice period?',
  }];
  for (const item of cases) {
    const questions: PostingQuestion[] = [{
      label: item.question,
      input_type: 'select-one',
      options: ['Yes', 'No'],
      required: true,
      max_length: null,
    }];
    const resolution = resolvePrescript(questions, {}, new Map(), { company: item.company });
    const response = prescriptResponse(
      '00000000-0000-4000-8000-000000000002',
      { ...responseTarget, company: item.company },
      questions,
      [],
      'ok',
      new Date('2026-08-23T12:00:00.000Z'),
      true,
      resolution,
    );

    assert.equal(response.discovery_status, 'ok', item.company);
    assert.deepEqual(response.metadata_blockers, [], item.company);
    assert.equal(response.ask[0]?.question, item.question, item.company);
    assert.deepEqual(response.ask[0]?.options, ['Yes', 'No'], item.company);
    assert.equal(response.ask[0]?.answer, '', item.company);
    assert.equal(response.ask[0]?.required, true, item.company);
    assert.ok(response.ask[0]?.explanation, item.company);
  }
});

test('the endpoint is authenticated and takes a board posting id', () => {
  assert.match(ROUTE, /fastify\.get\('\/postings\/:jobId\/questions', \{ preHandler: requireAuth \}/);
  assert.match(ROUTE, /paramsSchema = z\.object\(\{ jobId: z\.string\(\)\.uuid\(\) \}\)/);
});

test('the route is registered', () => {
  const index = readFileSync('src/index.ts', 'utf8');
  assert.match(index, /await fastify\.register\(postingQuestionsRoutes\);/);
});

test('submit-request is the one place an answer is remembered', () => {
  const applications = readFileSync('src/routes/applications.ts', 'utf8');
  const submitRequest = applications.slice(
    applications.indexOf("'/applications/:id/submit-request'"),
    applications.indexOf("'/applications/:id/submission'"),
  );
  assert.match(submitRequest, /rememberReusableAnswers\(/);
  // After every guard, so nothing that was rejected is remembered as her answer.
  assert.ok(
    submitRequest.indexOf('rememberReusableAnswers(') > submitRequest.indexOf('Sensitive question requires your attention'),
    'answers are remembered only once they have passed every check',
  );
  // Best effort: failing to remember costs her one retype, failing her submission costs the job.
  assert.match(submitRequest, /rememberReusableAnswers\([\s\S]{0,600}?\)\.catch\(/);
  // And exactly one write path, so an answer she later edits cannot be shadowed by an earlier one.
  assert.equal(applications.split('rememberReusableAnswers(').length - 1, 1, 'exactly one call site');
});
