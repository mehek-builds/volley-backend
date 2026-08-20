import assert from 'node:assert/strict';
import test from 'node:test';
import { EMAIL_MATCH_DISPLAY_FLOOR, employerReplyEmail, foundPhrase, strongMatchEmail } from './notificationEmail';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const UNSUBSCRIBE = 'https://api.trylitos.com/notifications/unsubscribe?token=v1.strong_match.abc.def';

function matchEmail(over: Partial<Parameters<typeof strongMatchEmail>[0]['job']> = {}, score = 87) {
  return strongMatchEmail({
    to: 'student@example.edu',
    unsubscribeUrl: UNSUBSCRIBE,
    now: NOW,
    score,
    job: {
      company_name: 'Ramp',
      title: 'Software Engineer Intern',
      location: 'New York, NY',
      first_seen_at: new Date('2026-08-19T08:00:00.000Z'),
      posting_url: 'https://job-boards.greenhouse.io/ramp/jobs/1234',
      company_domain: 'ramp.com',
      required_coverage: null,
      ...over,
    },
  });
}

test('the alert says Found and never Posted, in every field it renders', () => {
  /* THE RULE THIS PINS. monitored_jobs.posted_at is nullable and null on a large share of the
     board, so a claim about when an employer published a posting is a claim we frequently cannot
     support. first_seen_at is when OUR poll saw it, and that is what the copy is allowed to say.
     Asserted over the whole payload rather than over one line, because the failure mode is
     somebody adding a sentence, not somebody editing this one. */
  const email = matchEmail();
  const everything = `${email.subject}\n${email.text}\n${email.html ?? ''}`;
  assert.doesNotMatch(everything, /posted/i);
  assert.match(email.text, /Found 4 hours ago/);
  assert.match(email.html ?? '', /Found 4 hours ago/);
});

test('the plain text part keeps its paragraph breaks, with or without a location', () => {
  /* REGRESSION. The absent location used to be dropped by filtering empty strings out of the
     assembled array, which reads as if it only removes the location and in fact removed every
     deliberate blank line with it: the whole text part collapsed into seven unseparated lines. The
     blanks are content, so only the location slot may be conditional. */
  const withLocation = matchEmail().text.split('\n');
  assert.equal(withLocation.filter((line) => line === '').length, 2, 'both separators must survive');
  assert.equal(withLocation[0], 'Software Engineer Intern at Ramp');
  assert.equal(withLocation[1], 'New York, NY');
  assert.equal(withLocation[3], '');

  const withoutLocation = matchEmail({ location: null }).text.split('\n');
  assert.equal(withoutLocation.filter((line) => line === '').length, 2);
  assert.equal(withoutLocation[1], 'Found 4 hours ago. 87% match against your resume.', 'the location line is gone, not blanked');
});

test('the alert carries exactly one posting', () => {
  // Never a digest. Ten postings a day trains somebody to archive the sender unread, and then the
  // one that mattered is archived with them.
  const email = matchEmail();
  assert.equal(email.subject, 'Software Engineer Intern at Ramp');
  assert.equal((email.text.match(/greenhouse\.io/g) ?? []).length, 1);
  assert.match(email.text, /87% match against your resume/);
});

test('every alert carries a way out, in the body and in the headers', () => {
  for (const email of [
    matchEmail(),
    employerReplyEmail({
      to: 'student@example.edu',
      unsubscribeUrl: UNSUBSCRIBE,
      company: 'Ramp',
      role: 'Software Engineer Intern',
      receivedAt: NOW,
    }),
  ]) {
    assert.ok(email.text.includes(UNSUBSCRIBE), 'the plain text part must carry the link too');
    assert.ok((email.html ?? '').includes(UNSUBSCRIBE));
    /* List-Unsubscribe-Post is what makes a mail client offer its own Unsubscribe control instead
       of leaving the spam button as the only exit, and a spam complaint costs the sending domain
       the deliverability every student's application mail depends on. */
    assert.equal(email.headers?.['List-Unsubscribe'], `<${UNSUBSCRIBE}>`);
    assert.equal(email.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  }
});

test('a posting with no location renders without one rather than inventing a place', () => {
  const email = matchEmail({ location: null });
  assert.doesNotMatch(email.text, /New York/);
  assert.match(email.text, /Software Engineer Intern at Ramp/);
});

test('company and title are escaped into the HTML', () => {
  const email = matchEmail({ company_name: 'Ramp & Co <script>', title: 'Intern "2027"' });
  assert.doesNotMatch(email.html ?? '', /<script>/);
  assert.match(email.html ?? '', /Ramp &amp; Co/);
});

test('a score below the display floor drops the percentage but keeps the found phrase', () => {
  /* MIN_RANKED_MATCH_SCORE (the board's own floor) is 25, so "strong match" alone already promises
     more than a 31% score backs up. The email must not print a number that undercuts its own claim
     in the same sentence. */
  const weak = matchEmail({}, 31);
  assert.doesNotMatch(weak.text, /\d+% match/);
  assert.doesNotMatch(weak.html ?? '', /\d+% match/);
  assert.match(weak.text, /Found 4 hours ago\./);
  assert.match(weak.html ?? '', /Found 4 hours ago\./);

  const strong = matchEmail({}, EMAIL_MATCH_DISPLAY_FLOOR);
  assert.match(strong.text, /70% match against your resume/);
  assert.match(strong.html ?? '', /70% match/);
});

test('the email never claims "strong" for a score the board itself would not call strong', () => {
  /* The board's own scoreBand() draws "Strong match" at 40, not at MIN_RANKED_MATCH_SCORE's 25 -
     the floor this alert sends on. A score of 31 clears the send floor but not the board's own bar,
     so the email must not say "A strong match opened" for it: a student who clicks through from
     that claim to a board that labels the same posting "Solid match" is the exact failure this
     file's own docstring warns against - the score stops being a measurement and becomes copy. */
  const belowBoardBar = matchEmail({}, 31);
  assert.doesNotMatch(belowBoardBar.html ?? '', /A strong match opened/);
  assert.match(belowBoardBar.html ?? '', /A new match opened/);

  const atBoardBar = matchEmail({}, 40);
  assert.match(atBoardBar.html ?? '', /A strong match opened/);
  assert.doesNotMatch(atBoardBar.html ?? '', /A new match opened/);
});

test('a high score with most hard requirements unmet is also not claimed "strong"', () => {
  /* scoreBand's SECOND gate, independent of the score threshold: less than half the requirements
     block covered caps the band at "Missing key requirements" even at a score that clears 40. A
     review caught that the first version of this fix called scoreBand(score) alone, so this gate
     could never fire from the email and the board/email disagreement just moved from the score
     axis to the coverage axis instead of actually closing. required_coverage has to reach here for
     the gate to work at all. */
  const highScoreLowCoverage = matchEmail({ required_coverage: 0.25 }, 61);
  assert.doesNotMatch(highScoreLowCoverage.html ?? '', /A strong match opened/);
  assert.match(highScoreLowCoverage.html ?? '', /A new match opened/);

  // Same score, requirements mostly covered: the gate must not fire when it should not.
  const highScoreGoodCoverage = matchEmail({ required_coverage: 0.9 }, 61);
  assert.match(highScoreGoodCoverage.html ?? '', /A strong match opened/);
});

test('the CTA sends a student to the Litos dashboard, not straight to the employer', () => {
  const email = matchEmail();
  assert.match(email.html ?? '', /Open your Litos dashboard/);
  assert.match(email.text, /Open your Litos dashboard: https:\/\/trylitos\.com\/dashboard\/jobs/);
  // The original posting is still reachable, but only as the secondary link.
  assert.match(email.html ?? '', /Prefer the original listing\?/);
  assert.match(email.text, /Prefer the original listing\? https:\/\/job-boards\.greenhouse\.io/);
});

test('the company logo renders from the resolved domain, and falls back to an initial without one', () => {
  const withDomain = matchEmail({ company_domain: 'ramp.com' });
  assert.match(withDomain.html ?? '', /google\.com\/s2\/favicons\?domain=ramp\.com/);

  const withoutDomain = matchEmail({ company_domain: null });
  assert.doesNotMatch(withoutDomain.html ?? '', /google\.com\/s2\/favicons/);
  assert.match(withoutDomain.html ?? '', /email-logo-fallback/);
});

test('the shell declares a dark palette so the email is legible in both color schemes', () => {
  const email = matchEmail();
  assert.match(email.html ?? '', /name="color-scheme" content="light dark"/);
  assert.match(email.html ?? '', /prefers-color-scheme: dark/);
});

test('the reply alert says mail arrived and never says what it said', () => {
  /* Employer mail that Litos is willing to hand over already leaves by the forwarding path, in
     full. This alert exists for the classes that path deliberately keeps internal, so copying
     contents in here would route around that decision. It also refuses to imply the news is good:
     the classifier behind it is regexes over a subject line. */
  const email = employerReplyEmail({
    to: 'student@example.edu',
    unsubscribeUrl: UNSUBSCRIBE,
    company: 'Ramp',
    role: 'Software Engineer Intern',
    receivedAt: NOW,
  });
  assert.equal(email.subject, 'Ramp replied to your application');
  assert.match(email.text, /Mail arrived for Software Engineer Intern at Ramp/);
  assert.match(email.text, /dashboard\/applications/);
  assert.doesNotMatch(`${email.subject}\n${email.text}`, /interview|congratulations|good news|offer/i);
});

test('the reply alert names no employer rather than guessing at one', () => {
  const email = employerReplyEmail({
    to: 'student@example.edu',
    unsubscribeUrl: UNSUBSCRIBE,
    company: null,
    role: null,
    receivedAt: NOW,
  });
  assert.equal(email.subject, 'An employer replied to your application');
  assert.match(email.text, /one of your applications/);
});

test('the found phrase is coarse at the top end and never dates the employer', () => {
  const seen = (iso: string) => foundPhrase(new Date(iso), NOW);
  assert.equal(seen('2026-08-19T11:59:30.000Z'), 'Found just now');
  assert.equal(seen('2026-08-19T11:20:00.000Z'), 'Found 40 minutes ago');
  assert.equal(seen('2026-08-19T11:00:00.000Z'), 'Found 1 hour ago');
  assert.equal(seen('2026-08-19T02:00:00.000Z'), 'Found 10 hours ago');
  assert.equal(seen('2026-08-18T09:00:00.000Z'), 'Found yesterday');
  assert.equal(seen('2026-08-16T09:00:00.000Z'), 'Found 3 days ago');
  /* Past a week the elapsed form stops being worth saying and starts being an argument for opening
     something stale, so it becomes a date. */
  assert.equal(seen('2026-08-01T09:00:00.000Z'), 'Found on 1 August');
  // A clock skew that puts first_seen_at in the future must not render a negative age.
  assert.equal(seen('2026-08-19T12:05:00.000Z'), 'Found just now');
});
