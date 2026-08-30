import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db';
import { application_profile } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import {
  encryptionKeyTransitionConfigured,
  looksEncrypted,
  reencryptFieldWithNextKey,
} from '../lib/fieldCrypto';
import { ENCRYPTED_FIELDS } from './applicationProfile';

export const PROFILE_REKEY_FIELDS = [
  ...ENCRYPTED_FIELDS,
  'work_eligibility_by_country',
] as const;

type RekeyableProfileRow = {
  user_id: string;
} & Record<string, unknown>;

export type ProfileRekeyResult = {
  profiles_scanned: number;
  profiles_updated: number;
  envelopes_reencrypted: number;
};

export function rekeyApplicationProfileRow(row: RekeyableProfileRow): {
  updates: Record<string, string>;
  envelopes: number;
} {
  const updates: Record<string, string> = {};
  for (const field of PROFILE_REKEY_FIELDS) {
    const stored = row[field];
    if (typeof stored !== 'string' || !looksEncrypted(stored)) continue;
    updates[field] = reencryptFieldWithNextKey(stored);
  }
  return { updates, envelopes: Object.keys(updates).length };
}

export interface EncryptionRekeyDependencies {
  rekeyProfiles: () => Promise<ProfileRekeyResult>;
}

async function rekeyProfilesInOneTransaction(): Promise<ProfileRekeyResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(application_profile).for('update');
    let profilesUpdated = 0;
    let envelopesReencrypted = 0;

    for (const row of rows) {
      const { updates, envelopes } = rekeyApplicationProfileRow(row as RekeyableProfileRow);
      if (envelopes === 0) continue;
      await tx
        .update(application_profile)
        .set(updates)
        .where(eq(application_profile.user_id, row.user_id));
      profilesUpdated += 1;
      envelopesReencrypted += envelopes;
    }

    return {
      profiles_scanned: rows.length,
      profiles_updated: profilesUpdated,
      envelopes_reencrypted: envelopesReencrypted,
    };
  });
}

async function handleRekey(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: EncryptionRekeyDependencies,
) {
  if (!isCronConfigured()) {
    return reply.status(503).send({ error: 'encryption rekey is not configured' });
  }
  if (!isCronAuthorized(request)) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
  if (!encryptionKeyTransitionConfigured()) {
    return reply.status(503).send({ error: 'ENCRYPTION_KEY_NEXT is not configured' });
  }

  const result = await dependencies.rekeyProfiles();
  return reply.status(200).send({
    ...result,
    verified_with_next_key: true,
  });
}

export async function encryptionRekeyRoutes(
  fastify: FastifyInstance,
  options: { dependencies?: EncryptionRekeyDependencies } = {},
) {
  const dependencies = options.dependencies ?? { rekeyProfiles: rekeyProfilesInOneTransaction };
  fastify.post('/internal/encryption-rekey', (request, reply) =>
    handleRekey(request, reply, dependencies));
}
