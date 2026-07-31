import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEmployerIndustry, classifyJobFamily, summarizeJobVariety } from './jobVariety';

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
  assert.equal(summary.industry_classification_coverage, 0);
  assert.equal(summary.remote_share, 0);
  assert.equal(summary.concentration.top_employer, null);
  assert.equal(summary.concentration.top_employer_share, 0);
});
