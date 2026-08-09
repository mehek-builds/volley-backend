#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Generates a fresh one-time canary token and sends it to Vercel over stdin. The token and derived
// recipient never appear in argv, stdout, stderr, or a file. This script only configures the token;
// it deliberately does not deploy or send mail.
const token = randomBytes(32).toString('base64url').toLowerCase();
const result = spawnSync('vercel', [
  'env',
  'add',
  'LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN',
  'production',
  '--yes',
  '--force',
], {
  input: `${token}\n`,
  encoding: 'utf8',
});

if (result.status !== 0) {
  console.error('Canary configuration failed. No token or recipient was printed.');
  process.exit(result.status || 1);
}
console.log('Ready: configured a fresh hidden managed-receiving canary token. Redeploy before sending the canary.');
