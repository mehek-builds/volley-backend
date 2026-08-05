import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJdSignals } from './jdSignals';

test('extractJdSignals separates hard requirements, preferences, tools, experience asks and verbs', () => {
  const jd = `
What you'll do
- Lead customer discovery, design demos, and partner with engineering to ship proof-of-concept repos.
- Drive adoption across enterprise accounts.

Required Qualifications
- 7-10+ years of experience in senior commercial roles within Account Management, Customer Success, or Business Development.
- Proven track record managing people managers and coaching quota-carrying outbound sales teams.
- Advanced Excel/Google Sheets skills with experience building financial models and scenario analyses.
- Located in London with ability to travel across EMEA.

Desired
- Experience with Salesforce, Tableau, CLM, and JIRA is preferred.
- Familiarity with dev-tools SaaS companies is a plus.
`;

  const signals = extractJdSignals(jd, { company: 'Example', role: 'Sales Engineering Manager' });

  assert.ok(signals.hard_requirements.some((line) => /7-10\+ years/.test(line)));
  assert.ok(signals.hard_requirements.some((line) => /quota-carrying outbound sales/.test(line)));
  assert.ok(signals.preferences.some((line) => /Salesforce, Tableau, CLM, and JIRA/.test(line)));
  assert.deepEqual(
    ['Excel', 'Google Sheets', 'Salesforce', 'Tableau', 'CLM', 'JIRA'].filter((tool) =>
      signals.tools_and_skills.includes(tool),
    ),
    ['Excel', 'Google Sheets', 'Salesforce', 'Tableau', 'CLM', 'JIRA'],
  );
  assert.ok(signals.experience_requirements.some((line) => /financial models/.test(line)));
  assert.ok(signals.action_verbs.includes('lead'));
  assert.ok(signals.action_verbs.includes('drive'));
  assert.ok(!signals.hard_requirements.some((line) => /Located in London/.test(line)));
});

test('extractJdSignals keeps technical delivery experience as an experience requirement', () => {
  const jd = `
The impact you will have:
- Architect and implement data applications with customers.

What we look for:
- 8+ years experience in data engineering, data platforms and analytics, or software engineering.
- Deep experience with distributed computing with Apache Spark and knowledge of Spark runtime internals.
- Experience with technical project delivery: managing scope, timelines, and measurable outcomes.
- Familiarity with CI/CD for production deployments.
`;

  const signals = extractJdSignals(jd, { company: 'Databricks', role: 'Forward Deployed Engineer' });

  assert.ok(signals.hard_requirements.some((line) => /8\+ years experience/.test(line)));
  assert.ok(signals.experience_requirements.some((line) => /technical project delivery/.test(line)));
  assert.ok(signals.tools_and_skills.includes('Spark'));
  assert.ok(signals.tools_and_skills.some((term) => /CI\/CD/i.test(term) || /ci cd/i.test(term)));
  assert.ok(signals.action_verbs.includes('architect'));
  assert.ok(signals.action_verbs.includes('implement'));
});

test('extractJdSignals falls back to body experience asks when a posting has no headings', () => {
  const jd = `
We are hiring a Sales Director to build payment partnerships.
Experience within financial services, cybersecurity, or cryptocurrency is preferred.
Experience in formalising and supporting the co-sell motion in working with technology partners is preferred.
You will prospect, qualify, and drive enterprise deals.
`;

  const signals = extractJdSignals(jd, { company: 'Fireblocks', role: 'Sales Director, Payments' });

  assert.equal(signals.hard_requirements.length, 0);
  assert.ok(signals.preferences.some((line) => /financial services/.test(line)));
  assert.ok(signals.preferences.some((line) => /co-sell motion/.test(line)));
  assert.ok(signals.action_verbs.includes('prospect'));
  assert.ok(!signals.tools_and_skills.some((term) => /Bank|Middle East/i.test(term)));
});

test('extractJdSignals treats what you should have as candidate-fit requirements', () => {
  const jd = `
WHAT YOU'LL DO
- Own demos and support enterprise customers.

WHAT YOU SHOULD HAVE
- Strong technical skills that allow you to read, write and debug code (Javascript/Node.js preferred).
- 5+ years experience in a Solutions Engineering, Sales Engineering, or Forward Deployed Engineer role.
- Ability to use AI tools to accelerate customer-facing work.
`;

  const signals = extractJdSignals(jd, { company: 'Checkly', role: 'Senior Sales Engineer' });

  assert.ok(signals.hard_requirements.some((line) => /debug code/.test(line)));
  assert.ok(signals.hard_requirements.some((line) => /5\+ years experience/.test(line)));
  assert.ok(signals.experience_requirements.some((line) => /Solutions Engineering/.test(line)));
  assert.ok(signals.tools_and_skills.includes('Node.js'));
  assert.ok(signals.tools_and_skills.includes('JavaScript'));
});
