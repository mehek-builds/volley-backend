#!/usr/bin/env node

import pg from 'pg';
import {
  assertControlledSecurityCodeTarget,
  assertDisposableDatabaseMarker,
  controlledManagedReceivingProof,
} from './qa-guest-submissions-lib.mjs';

const databaseUrl = process.env.DATABASE_URL;
const databaseMarker = process.env.QA_CONTROLLED_DATABASE_MARKER;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

assertControlledSecurityCodeTarget({
  apiBase: process.env.QA_API_BASE ?? 'http://127.0.0.1:3301',
  websiteBase: process.env.QA_WEBSITE_BASE ?? 'http://127.0.0.1:3300',
  portalPublicBase: process.env.QA_PORTAL_PUBLIC_BASE ?? 'http://127.0.0.1:3300',
  databaseConfirmed: process.env.QA_CONTROLLED_DATABASE === '1',
  publicPortalConfirmed: process.env.QA_CONTROLLED_PORTAL_PUBLIC === '1',
  databaseUrl,
  databaseMarker,
  portalBindingSecret: process.env.LITOS_TEST_PORTAL_BINDING_SECRET,
  configuredPortalOrigin: process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN,
});

const proof = controlledManagedReceivingProof({
  routeMode: process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE,
  domain: process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN,
  aliasSecret: process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET
    ?? process.env.LITOS_APPLICATION_EMAIL_SECRET
    ?? process.env.JWT_SIGNING_SECRET,
  canaryToken: process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN,
  webhookEndpoint: process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_URL,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  receivingApiKey: process.env.RESEND_RECEIVING_API_KEY ?? process.env.RESEND_API_KEY,
  databaseMarker,
});

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const markerResult = await client.query(
    `select marker, expires_at
       from litos_qa_control
      where scope = 'security-code-e2e'
      limit 1`,
  );
  assertDisposableDatabaseMarker(markerResult.rows[0], databaseMarker);
  await client.query(
    `insert into application_email_receiving_proofs
       (provider_message_hash, route_fingerprint, proof_version, domain, verified_at)
     values ($1, $2, $3, $4, now())
     on conflict (route_fingerprint) do update
       set provider_message_hash = excluded.provider_message_hash,
           proof_version = excluded.proof_version,
           domain = excluded.domain,
           verified_at = now()`,
    [proof.provider_message_hash, proof.route_fingerprint, proof.proof_version, proof.domain],
  );
} finally {
  await client.end();
}

console.log(JSON.stringify({ prepared: true, proof_version: proof.proof_version, domain: proof.domain }));
