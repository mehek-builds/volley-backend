import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  LINKEDIN_CSV_CONSENT_VERSION,
  MAX_LINKEDIN_CSV_BYTES,
  parseLinkedInConnectionsCsv,
  statusProjection,
} from './network';

const headers = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';

describe('LinkedIn Connections.csv validation', () => {
  test('accepts the documented shape, quoted values, and LinkedIn preamble', () => {
    const csv = [
      'Notes:',
      'This file contains connection data.',
      headers,
      '"Ada","Lovelace","https://www.linkedin.com/in/ada/?trk=export","ada@example.test","Analytical, Inc.","Engineer","14 Aug 2026"',
      '"Grace","Hopper","https://linkedin.com/in/grace","grace@example.test","Navy","Rear Admiral","2020-01-02"',
    ].join('\r\n');
    const parsed = parseLinkedInConnectionsCsv(Buffer.from(csv), new Date('2026-08-14T12:00:00.000Z'));
    assert.equal(parsed.row_count, 2);
    assert.equal(parsed.accepted_rows, 2);
    assert.equal(parsed.rejected_rows, 0);
    assert.equal(parsed.rows[0].company_name, 'Analytical, Inc.');
    assert.equal(parsed.rows[0].profile_url, 'https://www.linkedin.com/in/ada');
    assert.equal('email' in parsed.rows[0], false);
    assert.match(parsed.warnings[0], /never stored/);
  });

  test('rejects non-LinkedIn shape and executable file signatures', () => {
    assert.throws(
      () => parseLinkedInConnectionsCsv(Buffer.from('name,company\nAda,Acme')),
      (error: unknown) => (error as { code?: string }).code === 'invalid_linkedin_shape',
    );
    assert.throws(
      () => parseLinkedInConnectionsCsv(Buffer.from('MZ executable bytes')),
      (error: unknown) => (error as { code?: string }).code === 'unsupported_file',
    );
  });

  test('rejects unsafe rows and duplicate identities without exposing row contents', () => {
    const csv = [
      headers,
      'Ada,Lovelace,https://www.linkedin.com/in/ada,ada@example.test,Acme,Engineer,2020-01-02',
      'Ada,Lovelace,https://www.linkedin.com/in/ada,other@example.test,Acme,Engineer,2020-01-02',
      '=cmd,Person,https://www.linkedin.com/in/cmd,cmd@example.test,Acme,Engineer,2020-01-02',
    ].join('\n');
    const parsed = parseLinkedInConnectionsCsv(Buffer.from(csv));
    assert.equal(parsed.accepted_rows, 1);
    assert.equal(parsed.rejected_rows, 2);
    assert.equal(parsed.warnings.some((warning) => warning.includes('cmd@example.test')), false);
  });

  test('publishes the approved consent version and exact 20 MB cap', () => {
    assert.equal(LINKEDIN_CSV_CONSENT_VERSION, 'linkedin_csv_v1');
    assert.equal(MAX_LINKEDIN_CSV_BYTES, 20 * 1024 * 1024);
  });

  test('a disconnect hides retained data from active-use status until consent is granted again', () => {
    const importedAt = new Date('2026-08-14T12:00:00.000Z');
    const connected = statusProjection({
      activeConsent: { consent_version: LINKEDIN_CSV_CONSENT_VERSION },
      latestImport: { committed_at: importedAt, source: 'linkedin_csv' },
      peopleCount: 42,
    });
    assert.equal(connected.connected, true);
    assert.equal(connected.data_use_active, true);
    assert.equal(connected.imported_people_count, 42);

    const disconnected = statusProjection({
      activeConsent: undefined,
      latestImport: { committed_at: importedAt, source: 'linkedin_csv' },
      peopleCount: 42,
    });
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.data_use_active, false);
    assert.equal(disconnected.source, null);
    assert.equal(disconnected.imported_people_count, 0);
    assert.equal(disconnected.retained_people_count, 42);
  });
});

test('network routes keep management available and entitlement-gate discovery reads', () => {
  const source = readFileSync('src/routes/network.ts', 'utf8');
  for (const managementRoute of [
    '/network/linkedin/status',
    '/network/linkedin/import/preview',
    '/network/linkedin/import/preview/:id',
    '/network/linkedin/import/commit',
    '/network/linkedin/disconnect',
    '/network/linkedin/data',
  ]) {
    assert.match(source, new RegExp(managementRoute.replaceAll('/', '\\/')));
  }
  assert.match(source, /requireFeature\(userId, 'networking_discovery', 'network_people_read'\)/);
  assert.match(source, /requireFeature\(userId, 'connected_companies', 'network_companies_read'\)/);
  assert.equal((source.match(/hasActiveLinkedInCsvConsent\(userId\)/g) ?? []).length, 2);
  assert.match(source, /code: 'network_consent_inactive'/);
  assert.match(source, /raw_deleted_at: now/);
  assert.doesNotMatch(source, /oauth\/start|oauth\/callback/);
});
