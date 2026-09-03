import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isRemoteLocation, matchingRoleType, normalizeTargeting, preferenceFit, roleTypeEmploymentPattern, roleTypePattern, targetTitleTerms } from './jobPreferences';

describe('job preferences', () => {
  test('normalizes saved account preferences without trusting jsonb values', () => {
    assert.deepStrictEqual(normalizeTargeting({
      categories: ['product'],
      titles: [' Product Manager ', 4],
      role_types: ['internship', 'volunteer'],
      locations: ['Dubai', 'London'],
      remote_only: true,
    }), {
      categories: ['product'],
      titles: ['Product Manager'],
      role_types: ['internship'],
      locations: ['Dubai', 'London'],
      remote_only: true,
      primary_period: null,
      backup_period: null,
    });
  });

  test('selected categories expand to the real title vocabulary used by postings', () => {
    const terms = targetTitleTerms(normalizeTargeting({ categories: ['software-engineering'] }));
    assert.ok(terms.includes('frontend'));
    assert.ok(terms.includes('backend'));
    assert.ok(terms.includes('software'));
  });

  test('multi-word titles survive an employer inserting the season into its title', () => {
    const terms = targetTitleTerms(normalizeTargeting({ titles: ['Investment Banking Analyst'] }));
    assert.ok(terms.includes('investment banking'));
    assert.ok(terms.includes('banking analyst'));
  });

  test('role types classify internships, co-ops, new-grad roles and ordinary full-time jobs', () => {
    assert.equal(matchingRoleType({ title: 'Product Management Intern' }, ['internship']), 'internship');
    assert.equal(matchingRoleType({ title: 'Software Engineer Co-op' }, ['co-op']), 'co-op');
    assert.equal(matchingRoleType({ title: 'New Graduate Data Analyst' }, ['new-grad']), 'new-grad');
    assert.equal(matchingRoleType({ title: 'Product Manager', employment_type: 'Full-time' }, ['full-time']), 'full-time');
    assert.equal(matchingRoleType({ title: 'Software Engineering Intern', employment_type: 'Full-time' }, ['full-time']), null);
    assert.equal(matchingRoleType({ title: 'Part-time Product Manager' }, ['full-time']), null);
  });

  test('the SQL role pattern covers every non-full-time selected type', () => {
    const pattern = roleTypePattern(['internship', 'co-op', 'new-grad']);
    assert.ok(pattern);
    assert.match('Product Intern', new RegExp(pattern!, 'i'));
    assert.match('Engineering Co-op', new RegExp(pattern!, 'i'));
    assert.match('New Graduate Analyst', new RegExp(pattern!, 'i'));
  });

  test('the four stages added beside the original four classify on their own evidence', () => {
    assert.equal(matchingRoleType({ title: 'Software Engineering Apprentice' }, ['apprenticeship']), 'apprenticeship');
    assert.equal(matchingRoleType({ title: 'AI Residency Fellow' }, ['fellowship']), 'fellowship');
    assert.equal(matchingRoleType({ title: 'Part-Time Data Analyst' }, ['part-time']), 'part-time');
    assert.equal(matchingRoleType({ title: 'Contract UX Designer' }, ['contract']), 'contract');
    // The column, not the title. This is the whole reason roleTypeEmploymentPattern exists: a
    // board that states the arrangement in employment_type and writes a plain title would
    // otherwise return this row to nobody who asked for contract work.
    assert.equal(matchingRoleType({ title: 'Marketing Associate', employment_type: 'Contract' }, ['contract']), 'contract');
    assert.equal(matchingRoleType({ title: 'Marketing Associate', employment_type: 'Part time' }, ['part-time']), 'part-time');
  });

  test('the new stages do not change what a saved full-time preference returns', () => {
    // A student whose only stage is full-time has been shown residencies and apprenticeships
    // since before either chip existed. Adding the chips must not quietly shrink that feed.
    assert.equal(matchingRoleType({ title: 'AI Residency Fellow', employment_type: 'Full-time' }, ['full-time']), 'full-time');
    assert.equal(matchingRoleType({ title: 'Software Apprentice', employment_type: 'Full-time' }, ['full-time']), 'full-time');
    // And the two that were already excluded stay excluded, from the title or from the column.
    assert.equal(matchingRoleType({ title: 'Contract UX Designer', employment_type: 'Full-time' }, ['full-time']), null);
    assert.equal(matchingRoleType({ title: 'Marketing Associate', employment_type: 'Contract' }, ['full-time']), null);
  });

  test('the SQL role pattern covers the added title-stated stages', () => {
    const pattern = roleTypePattern(['apprenticeship', 'fellowship', 'part-time', 'contract']);
    assert.ok(pattern);
    const expression = new RegExp(pattern!, 'i');
    assert.match('Engineering Apprentice', expression);
    assert.match('Research Fellowship', expression);
    assert.match('Part-Time Barista', expression);
    assert.match('Part Time Barista', expression);
    // 'Contractor' needs its own alternative: the pattern wraps each term in ([^a-z]|$), which a
    // bare 'contract' cannot satisfy against the following 'o'.
    assert.match('Independent Contractor', expression);
    assert.doesNotMatch('Software Engineer', expression);
  });

  test('only part-time and contract read the employment_type column', () => {
    assert.equal(roleTypeEmploymentPattern(['internship', 'co-op', 'new-grad', 'full-time']), null);
    assert.equal(roleTypeEmploymentPattern(['apprenticeship', 'fellowship']), null);
    const pattern = roleTypeEmploymentPattern(['part-time', 'contract']);
    assert.ok(pattern);
    const expression = new RegExp(pattern!, 'i');
    assert.match('Part-time', expression);
    assert.match('Part time', expression);
    assert.match('Temporary', expression);
    assert.doesNotMatch('Full-time', expression);
  });

  test('saved titles outrank a generic category match and explain the result', () => {
    const targeting = normalizeTargeting({
      categories: ['product'],
      titles: ['Product Manager'],
      role_types: ['full-time'],
      locations: ['Dubai'],
    });
    const exact = preferenceFit({ title: 'Product Manager', location: 'Dubai', employment_type: 'Full-time' }, targeting);
    const broad = preferenceFit({ title: 'Product Operations Analyst', location: 'Dubai', employment_type: 'Full-time' }, targeting);
    assert.ok(exact.score > broad.score);
    assert.ok(exact.reasons.includes('Product Manager'));
    assert.ok(exact.reasons.includes('Dubai'));
  });

  test('Remote is a place, and it reads the remote flag rather than the location text', () => {
    assert.equal(isRemoteLocation('Remote'), true);
    assert.equal(isRemoteLocation('remote (US)'), true);
    assert.equal(isRemoteLocation('Anywhere'), true);
    assert.equal(isRemoteLocation('Remotesville, TX'), false);
    assert.equal(isRemoteLocation('London, UK'), false);

    // Picked alongside real cities: a remote posting labelled with a head-office city still counts.
    const targeting = normalizeTargeting({ locations: ['Remote', 'London, UK'] });
    const remoteJob = preferenceFit({ title: 'Software Engineer', location: 'New York, NY', remote: true }, targeting);
    assert.ok(remoteJob.reasons.includes('remote preference'));

    // And an on-site job in one of the named cities is unaffected.
    const cityJob = preferenceFit({ title: 'Software Engineer', location: 'London, UK', remote: false }, targeting);
    assert.ok(cityJob.reasons.includes('London, UK'));

    // "Remote" must never be matched as location text: a Remote, Oregon office job is not remote.
    const decoy = preferenceFit({ title: 'Software Engineer', location: 'Remote, OR', remote: false }, targeting);
    assert.ok(!decoy.reasons.includes('remote preference'));
  });
});
