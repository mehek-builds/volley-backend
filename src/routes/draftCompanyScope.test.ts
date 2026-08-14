import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalCompanyScope } from '../lib/entitlements';
import { canonicalDraftCompanyScope } from './draft';

test('draft reuses the stable domain carried by a resolved contact', () => {
  const resolveScope = canonicalCompanyScope({ companyName: 'Acme', domain: 'acme.example' });
  const draftScope = canonicalDraftCompanyScope({
    company: 'Acme',
    contact: { company_domain: 'https://www.acme.example/jobs' },
  });
  assert.equal(draftScope, resolveScope);
});

test('draft rejects conflicting top-level and resolved-contact domains', () => {
  assert.throws(() => canonicalDraftCompanyScope({
    company: 'Acme',
    company_domain: 'acme.example',
    contact: { company_domain: 'attacker.example' },
  }), /does not match/);
});

test('client company ids cannot override a stable domain scope', () => {
  const first = canonicalDraftCompanyScope({
    company: 'Acme',
    company_id: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
    company_domain: 'acme.example',
    contact: { company_domain: 'acme.example' },
  });
  const second = canonicalDraftCompanyScope({
    company: 'Acme',
    company_id: '8f9ef70c-347c-4f9c-974b-8c5f3a63f2b8',
    company_domain: 'acme.example',
    contact: { company_domain: 'acme.example' },
  });
  assert.equal(first, second);
  assert.equal(first, 'domain:acme.example');
});
