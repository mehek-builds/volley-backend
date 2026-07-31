import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE,
  MINIMUM_JOB_FAMILY_CLASSIFICATION_COVERAGE,
  MINIMUM_ACTIVE_EMPLOYER_INDUSTRIES,
  MINIMUM_ACTIVE_JOB_FAMILIES,
  classificationCoverage,
  classifyEmployerIndustry,
  classifyJobFamily,
  summarizeJobVariety,
} from './jobVariety';

test('classifies job families using title and department language', () => {
  assert.equal(classifyJobFamily('Account Executive'), 'sales_business_development');
  assert.equal(classifyJobFamily('Product Designer'), 'design');
  assert.equal(classifyJobFamily('Regulatory Affairs Specialist'), 'legal_compliance');
  assert.equal(classifyJobFamily('Registered Nurse'), 'healthcare_clinical');
  assert.equal(classifyJobFamily('Senior Software Engineer'), 'software_engineering');
  assert.equal(classifyJobFamily('Data Analyst'), 'data_analytics');
  assert.equal(classifyJobFamily('Manager', 'Talent Acquisition'), 'people_recruiting');
});

test('keeps employer industry classification explicit about unknown companies', () => {
  assert.equal(classifyEmployerIndustry('Stripe'), 'financial_services');
  assert.equal(classifyEmployerIndustry('OpenAI'), 'technology');
  assert.equal(classifyEmployerIndustry('A company not in the taxonomy'), 'unclassified');
});

test('summarizes employer, family, geography, type, ATS and concentration variety', () => {
  const summary = summarizeJobVariety([
    { company_name: 'Stripe', title: 'Account Executive', employment_type: 'Full time', remote: true, job_country: 'us', ats_name: 'greenhouse' },
    { company_name: 'Stripe', title: 'Data Analyst', employment_type: 'Contract', remote: false, job_country: 'non_us', ats_name: 'greenhouse' },
    { company_name: 'OpenAI', title: 'Product Designer', department: 'Design', employment_type: null, remote: false, job_country: 'unknown', ats_name: 'ashby' },
    { company_name: 'Unknown Co', title: 'Registered Nurse', employment_type: 'Part-Time', remote: true, job_country: 'unexpected', ats_name: 'workable' },
  ]);

  assert.equal(summary.total_postings, 4);
  assert.equal(summary.distinct_employers, 3);
  assert.equal(summary.job_families.sales_business_development, 1);
  assert.equal(summary.job_families.data_analytics, 1);
  assert.equal(summary.job_families.design, 1);
  assert.equal(summary.job_families.healthcare_clinical, 1);
  assert.equal(summary.employer_industries.financial_services, 2);
  assert.equal(summary.employer_industries.technology, 1);
  assert.equal(summary.employer_industries.unclassified, 1);
  assert.equal(summary.job_family_classification_coverage, 1);
  assert.equal(summary.industry_classification_coverage, 0.75);
  assert.deepEqual(summary.employment_types, { full_time: 1, part_time: 1, contract: 1, internship: 0, unstated: 1 });
  assert.deepEqual(summary.geographies, { us: 1, non_us: 1, unknown: 2 });
  assert.deepEqual(summary.ats, { greenhouse: 2, ashby: 1, workable: 1 });
  assert.equal(summary.remote_share, 0.5);
  assert.equal(summary.concentration.top_employer, 'stripe');
  assert.equal(summary.concentration.top_employer_share, 0.5);
  assert.equal(summary.concentration.employers_for_half_of_inventory, 1);
});

test('reports zero-safe ratios for an empty inventory', () => {
  const summary = summarizeJobVariety([]);
  assert.equal(summary.total_postings, 0);
  assert.equal(summary.job_family_classification_coverage, 0);
  assert.equal(summary.industry_classification_coverage, 0);
  assert.equal(summary.remote_share, 0);
  assert.equal(summary.concentration.top_employer, null);
  assert.equal(summary.concentration.top_employer_share, 0);
});

test('classification coverage has explicit independently evaluated thresholds', () => {
  assert.equal(MINIMUM_JOB_FAMILY_CLASSIFICATION_COVERAGE, 0.8);
  assert.equal(MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE, 0.7);
  assert.equal(MINIMUM_ACTIVE_JOB_FAMILIES, 10);
  assert.equal(MINIMUM_ACTIVE_EMPLOYER_INDUSTRIES, 6);
  const rows = [
    ['Stripe', 'Account Executive'],
    ['OpenAI', 'Software Engineer'],
    ['OneMedical', 'Registered Nurse'],
    ['Waymo', 'Hardware Engineer'],
    ['Reddit', 'Product Manager'],
    ['Spotify', 'Product Designer'],
    ['Khan Academy', 'Teacher'],
    ['Stripe', 'Financial Analyst'],
    ['OpenAI', 'Research Scientist'],
    ['OpenAI', 'People Operations Manager'],
  ].map(([company_name, title]) => ({
    company_name,
    title,
    remote: false,
    job_country: 'us',
    ats_name: 'greenhouse',
  }));
  const healthy = classificationCoverage(summarizeJobVariety(rows));
  assert.equal(healthy.job_family_coverage_met, true);
  assert.equal(healthy.industry_coverage_met, true);
  assert.equal(healthy.job_family_breadth_met, true);
  assert.equal(healthy.industry_breadth_met, true);
  assert.equal(healthy.all_coverage_thresholds_met, true);

  const uncovered = classificationCoverage(summarizeJobVariety([
    { company_name: 'Unknown Co', title: 'Wizard', remote: false, job_country: 'unknown', ats_name: 'workable' },
  ]));
  assert.equal(uncovered.job_family_coverage_met, false);
  assert.equal(uncovered.industry_coverage_met, false);
  assert.equal(uncovered.all_coverage_thresholds_met, false);
});
