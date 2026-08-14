import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  linked_network_accounts,
  network_company_matches,
  network_consents,
  network_edges,
  network_imports,
  network_people,
} from '../db/schema';
import { canonicalCompanyScope, requireFeature } from '../lib/entitlements';
import { requireAuth } from '../middleware/auth';
import { purgeExpiredNetworkImportPreviews } from '../lib/networkPreviewRetention';

export const MAX_LINKEDIN_CSV_BYTES = 20 * 1024 * 1024;
export const LINKEDIN_CSV_CONSENT_VERSION = 'linkedin_csv_v1';
export const LINKEDIN_CSV_DISCLOSURE = [
  'Litos reads first-degree connection names, LinkedIn profile URLs, companies, roles, and connection dates from your export to show network paths.',
  'Litos does not import email addresses, does not infer second-degree connections, and never sends LinkedIn messages.',
  'Disconnect stops future use. Delete removes imported network data.',
].join(' ');
export const LINKEDIN_CSV_DISCLOSURE_HASH = createHash('sha256').update(LINKEDIN_CSV_DISCLOSURE).digest('hex');

const LINKEDIN_SCOPES = ['first_degree_connections', 'company_matching', 'referral_paths'] as const;
const LINKEDIN_HEADERS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
] as const;
const MAX_CONNECTION_ROWS = 50_000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

type NormalizedNetworkPerson = {
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  profile_url: string | null;
  company_scope_key: string | null;
  company_name: string | null;
  title: string | null;
  connected_at: string | null;
  canonical_identity_key: string;
};

const normalizedNetworkPersonSchema = z.object({
  first_name: z.string().max(200).nullable(),
  last_name: z.string().max(200).nullable(),
  full_name: z.string().min(1).max(401),
  profile_url: z.string().url().max(1_000).nullable(),
  company_scope_key: z.string().max(256).nullable(),
  company_name: z.string().max(300).nullable(),
  title: z.string().max(300).nullable(),
  connected_at: z.string().datetime().nullable(),
  canonical_identity_key: z.string().length(64),
});

const normalizedPreviewRowsSchema = z.array(normalizedNetworkPersonSchema).max(MAX_CONNECTION_ROWS);

export class LinkedInCsvValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'LinkedInCsvValidationError';
  }
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let quoteClosed = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (quoteClosed) {
      if (character !== ',' && character !== '\r' && character !== '\n') {
        throw new LinkedInCsvValidationError('invalid_csv', 'The file is not a valid LinkedIn CSV export.');
      }
      quoteClosed = false;
    }
    if (character === '"') {
      if (field.length > 0) {
        throw new LinkedInCsvValidationError('invalid_csv', 'The file is not a valid LinkedIn CSV export.');
      }
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += character;
    }
  }
  if (quoted) throw new LinkedInCsvValidationError('invalid_csv', 'The file contains an unterminated quoted value.');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function cleanCell(value: string): string {
  return value.replace(/^\uFEFF/, '').trim();
}

function unsafeSpreadsheetCell(value: string): boolean {
  const trimmed = value.trimStart();
  return /^[=+@]/.test(trimmed)
    || /^-(?:\d|[=+@])/.test(trimmed)
    || /^-[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(trimmed)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function canonicalLinkedInProfileUrl(value: string): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LinkedInCsvValidationError('invalid_row', 'One or more rows contain invalid LinkedIn profile URLs.');
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (parsed.protocol !== 'https:' || host !== 'linkedin.com' || !parsed.pathname.toLowerCase().startsWith('/in/')) {
    throw new LinkedInCsvValidationError('invalid_row', 'One or more rows contain invalid LinkedIn profile URLs.');
  }
  parsed.hostname = 'www.linkedin.com';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

function parsedConnectedAt(value: string, now: Date): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now.getTime() + 24 * 60 * 60 * 1000) {
    throw new LinkedInCsvValidationError('invalid_row', 'One or more rows contain invalid connection dates.');
  }
  return new Date(parsed).toISOString();
}

export function parseLinkedInConnectionsCsv(buffer: Buffer, now = new Date()): {
  row_count: number;
  accepted_rows: number;
  rejected_rows: number;
  warnings: string[];
  rows: NormalizedNetworkPerson[];
} {
  if (buffer.length === 0) throw new LinkedInCsvValidationError('empty_file', 'Choose a non-empty LinkedIn connections CSV.');
  if (buffer.length > MAX_LINKEDIN_CSV_BYTES) {
    throw new LinkedInCsvValidationError('file_too_large', 'LinkedIn CSV uploads are limited to 20 MB.', 413);
  }
  const leading = buffer.subarray(0, 16);
  const signature = leading.toString('latin1');
  if (
    signature.startsWith('PK\u0003\u0004')
    || signature.startsWith('%PDF-')
    || signature.startsWith('MZ')
    || signature.startsWith('\u007fELF')
    || signature.startsWith('\u0089PNG')
    || buffer.includes(0)
  ) {
    throw new LinkedInCsvValidationError('unsupported_file', 'Only a plain-text LinkedIn connections CSV is accepted.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new LinkedInCsvValidationError('invalid_encoding', 'The LinkedIn CSV must use UTF-8 text encoding.');
  }
  if (/^\s*(?:<!doctype\s+html|<html|<script|<svg)/i.test(text)) {
    throw new LinkedInCsvValidationError('unsupported_file', 'Only a plain-text LinkedIn connections CSV is accepted.');
  }

  const records = parseCsvRecords(text);
  const expectedHeaders = new Set<string>(LINKEDIN_HEADERS);
  const headerIndex = records.findIndex((record, index) => {
    if (index >= 20 || record.length !== LINKEDIN_HEADERS.length) return false;
    const cleaned = record.map(cleanCell);
    return cleaned.length === expectedHeaders.size && cleaned.every((header) => expectedHeaders.has(header));
  });
  if (headerIndex < 0) {
    throw new LinkedInCsvValidationError(
      'invalid_linkedin_shape',
      'This does not match LinkedIn\'s documented Connections.csv export shape.',
    );
  }
  const headerMap = new Map(records[headerIndex].map((header, index) => [cleanCell(header), index]));
  const dataRecords = records.slice(headerIndex + 1).filter((record) => record.some((value) => cleanCell(value).length > 0));
  if (dataRecords.length > MAX_CONNECTION_ROWS) {
    throw new LinkedInCsvValidationError('too_many_rows', 'The LinkedIn CSV contains too many connection rows.');
  }

  const rows: NormalizedNetworkPerson[] = [];
  const seenIdentities = new Set<string>();
  let rejectedRows = 0;
  let duplicateRows = 0;
  for (const record of dataRecords) {
    try {
      if (record.length !== LINKEDIN_HEADERS.length || record.some(unsafeSpreadsheetCell)) {
        throw new LinkedInCsvValidationError('invalid_row', 'A connection row is not safe to import.');
      }
      const value = (header: typeof LINKEDIN_HEADERS[number]) => cleanCell(record[headerMap.get(header)!] ?? '');
      const firstName = value('First Name');
      const lastName = value('Last Name');
      const companyName = value('Company');
      const title = value('Position');
      if ((!firstName && !lastName) || firstName.length > 200 || lastName.length > 200
        || companyName.length > 300 || title.length > 300 || value('URL').length > 1_000) {
        throw new LinkedInCsvValidationError('invalid_row', 'A connection row contains invalid values.');
      }
      const fullName = `${firstName} ${lastName}`.trim();
      const profileUrl = canonicalLinkedInProfileUrl(value('URL'));
      const connectedAt = parsedConnectedAt(value('Connected On'), now);
      const companyScopeKey = companyName ? canonicalCompanyScope({ companyName }) : null;
      const identityBasis = profileUrl?.toLowerCase()
        ?? [fullName, companyName, title].map((item) => item.normalize('NFKC').toLowerCase()).join('|');
      const canonicalIdentityKey = createHash('sha256').update(identityBasis).digest('hex');
      if (seenIdentities.has(canonicalIdentityKey)) {
        duplicateRows += 1;
        rejectedRows += 1;
        continue;
      }
      seenIdentities.add(canonicalIdentityKey);
      rows.push({
        first_name: firstName || null,
        last_name: lastName || null,
        full_name: fullName,
        profile_url: profileUrl,
        company_scope_key: companyScopeKey,
        company_name: companyName || null,
        title: title || null,
        connected_at: connectedAt,
        canonical_identity_key: canonicalIdentityKey,
      });
    } catch (error) {
      if (!(error instanceof LinkedInCsvValidationError)) throw error;
      rejectedRows += 1;
    }
  }
  if (rows.length === 0) {
    throw new LinkedInCsvValidationError('no_valid_rows', 'No valid first-degree connections were found in the LinkedIn CSV.');
  }
  const warnings = ['Email Address is intentionally ignored and is never stored.'];
  if (rejectedRows > 0) warnings.push(`${rejectedRows} connection row${rejectedRows === 1 ? ' was' : 's were'} rejected.`);
  if (duplicateRows > 0) warnings.push(`${duplicateRows} duplicate connection row${duplicateRows === 1 ? ' was' : 's were'} ignored.`);
  return {
    row_count: dataRecords.length,
    accepted_rows: rows.length,
    rejected_rows: rejectedRows,
    warnings,
    rows,
  };
}

export function statusProjection(input: {
  activeConsent: { consent_version: string } | undefined;
  latestImport: { committed_at: Date | null; source: string } | undefined;
  peopleCount: number;
}) {
  const dataUseActive = Boolean(input.activeConsent);
  return {
    source: dataUseActive && (input.latestImport || input.peopleCount > 0) ? 'csv' as const : null,
    connected: dataUseActive,
    data_use_active: dataUseActive,
    imported_people_count: dataUseActive ? input.peopleCount : 0,
    retained_people_count: input.peopleCount,
    imported_at: input.latestImport?.committed_at?.toISOString() ?? null,
    refresh_available: false,
    consent_version: input.activeConsent?.consent_version ?? null,
    restricted_api_available: false,
    import_method: 'csv' as const,
    raw_file_retained: false,
    consent: {
      version: LINKEDIN_CSV_CONSENT_VERSION,
      disclosure: LINKEDIN_CSV_DISCLOSURE,
      disclosure_hash: LINKEDIN_CSV_DISCLOSURE_HASH,
      scopes: [...LINKEDIN_SCOPES],
    },
  };
}

async function hasActiveLinkedInCsvConsent(userId: string): Promise<boolean> {
  const rows = await db.select({ id: network_consents.id }).from(network_consents).where(and(
    eq(network_consents.user_id, userId),
    eq(network_consents.data_source, 'linkedin_csv'),
    eq(network_consents.consent_version, LINKEDIN_CSV_CONSENT_VERSION),
    isNull(network_consents.revoked_at),
  )).limit(1);
  return Boolean(rows[0]);
}

function inactiveNetworkConsentReply(reply: FastifyReply) {
  return reply.header('Cache-Control', 'private, no-store').status(409).send({
    error: 'LinkedIn CSV use is disconnected. Import again and provide consent to use network data.',
    code: 'network_consent_inactive',
    reconnect_url: '/dashboard/network',
    deletion_url: '/network/linkedin/data',
  });
}

async function readNetworkStatus(userId: string) {
  const [consents, imports, countRows] = await Promise.all([
    db.select({ consent_version: network_consents.consent_version }).from(network_consents).where(and(
      eq(network_consents.user_id, userId),
      eq(network_consents.data_source, 'linkedin_csv'),
      isNull(network_consents.revoked_at),
    )).limit(1),
    db.select({ committed_at: network_imports.committed_at, source: network_imports.source }).from(network_imports).where(and(
      eq(network_imports.user_id, userId),
      eq(network_imports.status, 'committed'),
      isNull(network_imports.deleted_at),
    )).orderBy(desc(network_imports.committed_at)).limit(1),
    db.select({ count: sql<number>`count(*)::int` }).from(network_people).where(and(
      eq(network_people.user_id, userId),
      eq(network_people.source, 'linkedin_csv'),
    )),
  ]);
  return statusProjection({
    activeConsent: consents[0],
    latestImport: imports[0],
    peopleCount: Number(countRows[0]?.count ?? 0),
  });
}

function sendCsvError(reply: FastifyReply, error: unknown) {
  if (error instanceof LinkedInCsvValidationError) {
    return reply.status(error.statusCode).send({ error: error.message, code: error.code });
  }
  const candidate = error as { code?: string; statusCode?: number; message?: string };
  if (candidate?.code === 'FST_REQ_FILE_TOO_LARGE' || candidate?.statusCode === 413) {
    return reply.status(413).send({ error: 'LinkedIn CSV uploads are limited to 20 MB.', code: 'file_too_large' });
  }
  throw error;
}

const commitSchema = z.object({ import_id: z.string().uuid() }).strict();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(1_000).default(250) });

export async function networkRoutes(fastify: FastifyInstance) {
  fastify.get('/network/linkedin/status', { preHandler: requireAuth }, async (request, reply) => {
    await purgeExpiredNetworkImportPreviews();
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send(await readNetworkStatus(request.jwtPayload!.userId));
  });

  fastify.post('/network/linkedin/import/preview', { preHandler: requireAuth }, async (request, reply) => {
    await purgeExpiredNetworkImportPreviews();
    const userId = request.jwtPayload!.userId;
    let fileBuffer: Buffer | null = null;
    let consentVersion: string | null = null;
    try {
      for await (const part of request.parts({
        limits: { fileSize: MAX_LINKEDIN_CSV_BYTES, files: 1, fields: 5, parts: 6 },
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'connections') {
            for await (const _chunk of part.file) { /* drain rejected upload */ }
            throw new LinkedInCsvValidationError('invalid_file_field', 'Upload the CSV in the connections field.');
          }
          if (!part.filename.toLowerCase().endsWith('.csv') || !ALLOWED_MIME_TYPES.has(part.mimetype.toLowerCase())) {
            for await (const _chunk of part.file) { /* drain rejected upload */ }
            throw new LinkedInCsvValidationError('unsupported_file', 'Only a plain-text LinkedIn Connections.csv is accepted.');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of part.file) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_LINKEDIN_CSV_BYTES) {
              throw new LinkedInCsvValidationError('file_too_large', 'LinkedIn CSV uploads are limited to 20 MB.', 413);
            }
            chunks.push(bytes);
          }
          if (part.file.truncated) {
            throw new LinkedInCsvValidationError('file_too_large', 'LinkedIn CSV uploads are limited to 20 MB.', 413);
          }
          fileBuffer = Buffer.concat(chunks, size);
        } else if (part.fieldname === 'consent_version') {
          consentVersion = String(part.value);
        }
      }
      if (!fileBuffer) throw new LinkedInCsvValidationError('file_required', 'Choose your LinkedIn Connections.csv file.');
      if (consentVersion !== LINKEDIN_CSV_CONSENT_VERSION) {
        throw new LinkedInCsvValidationError('consent_required', 'Review and accept the current LinkedIn import disclosure.');
      }
      const parsed = parseLinkedInConnectionsCsv(fileBuffer);
      const now = new Date();
      const [networkImport] = await db.insert(network_imports).values({
        user_id: userId,
        source: 'linkedin_csv',
        file_sha256: createHash('sha256').update(fileBuffer).digest('hex'),
        consent_version: LINKEDIN_CSV_CONSENT_VERSION,
        disclosure_hash: LINKEDIN_CSV_DISCLOSURE_HASH,
        row_count: parsed.row_count,
        accepted_rows: parsed.accepted_rows,
        rejected_rows: parsed.rejected_rows,
        validation_result: { warnings: parsed.warnings, documented_shape: true, email_imported: false },
        preview_rows: parsed.rows,
        status: 'previewed',
        expires_at: new Date(now.getTime() + PREVIEW_TTL_MS),
        raw_deleted_at: now,
      }).returning({ id: network_imports.id, expires_at: network_imports.expires_at });
      fileBuffer = null;
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(200).send({
        import_id: networkImport.id,
        accepted_rows: parsed.accepted_rows,
        rejected_rows: parsed.rejected_rows,
        warnings: parsed.warnings,
        expires_at: networkImport.expires_at.toISOString(),
        raw_file_retained: false,
        consent_version: LINKEDIN_CSV_CONSENT_VERSION,
        disclosure_hash: LINKEDIN_CSV_DISCLOSURE_HASH,
      });
    } catch (error) {
      fileBuffer = null;
      return sendCsvError(reply, error);
    }
  });

  fastify.post('/network/linkedin/import/commit', { preHandler: requireAuth }, async (request, reply) => {
    await purgeExpiredNetworkImportPreviews();
    const parsedBody = commitSchema.safeParse(request.body);
    if (!parsedBody.success) return reply.status(400).send({ error: 'Invalid request body', detail: parsedBody.error.issues });
    const userId = request.jwtPayload!.userId;
    const now = new Date();
    try {
      await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`network:${userId}`}, 0::bigint))`);
      const [networkImport] = await tx.select().from(network_imports).where(and(
        eq(network_imports.id, parsedBody.data.import_id),
        eq(network_imports.user_id, userId),
        isNull(network_imports.deleted_at),
      )).limit(1);
      if (!networkImport) throw new LinkedInCsvValidationError('import_not_found', 'The import preview was not found.', 404);
      if (networkImport.status === 'committed') return;
      if (networkImport.status !== 'previewed') {
        throw new LinkedInCsvValidationError('import_not_available', 'This import preview can no longer be committed.', 409);
      }
      if (networkImport.expires_at <= now) {
        await tx.update(network_imports).set({ status: 'expired', preview_rows: null }).where(eq(network_imports.id, networkImport.id));
        throw new LinkedInCsvValidationError('import_expired', 'This import preview expired. Upload the file again.', 410);
      }
      if (networkImport.consent_version !== LINKEDIN_CSV_CONSENT_VERSION
        || networkImport.disclosure_hash !== LINKEDIN_CSV_DISCLOSURE_HASH) {
        throw new LinkedInCsvValidationError('consent_outdated', 'The LinkedIn import disclosure changed. Preview the file again.', 409);
      }
      const rows = normalizedPreviewRowsSchema.parse(networkImport.preview_rows);

      await tx.update(network_consents).set({ revoked_at: now }).where(and(
        eq(network_consents.user_id, userId),
        eq(network_consents.data_source, 'linkedin_csv'),
        isNull(network_consents.revoked_at),
      ));
      await tx.insert(network_consents).values({
        user_id: userId,
        consent_version: LINKEDIN_CSV_CONSENT_VERSION,
        data_source: 'linkedin_csv',
        scopes: [...LINKEDIN_SCOPES],
        disclosure_hash: LINKEDIN_CSV_DISCLOSURE_HASH,
        granted_at: now,
      });
      await tx.delete(network_company_matches).where(eq(network_company_matches.user_id, userId));
      await tx.delete(network_edges).where(and(
        eq(network_edges.user_id, userId),
        eq(network_edges.source, 'linkedin_csv'),
      ));
      await tx.delete(network_people).where(and(
        eq(network_people.user_id, userId),
        eq(network_people.source, 'linkedin_csv'),
      ));

      const people = rows.map((row) => ({
        id: randomUUID(),
        edge_id: randomUUID(),
        ...row,
      }));
      for (let index = 0; index < people.length; index += 250) {
        const chunk = people.slice(index, index + 250);
        await tx.insert(network_people).values(chunk.map((person) => ({
          id: person.id,
          user_id: userId,
          canonical_identity_key: person.canonical_identity_key,
          first_name: person.first_name,
          last_name: person.last_name,
          full_name: person.full_name,
          profile_url: person.profile_url,
          company_scope_key: person.company_scope_key,
          company_name: person.company_name,
          title: person.title,
          source: 'linkedin_csv',
          source_import_id: networkImport.id,
          source_timestamp: person.connected_at ? new Date(person.connected_at) : null,
          provenance: {
            source: 'user_linkedin_export',
            relationship: 'first_degree',
            confidence: 'user_provided',
            imported_at: now.toISOString(),
          },
          created_at: now,
          updated_at: now,
        })));
        await tx.insert(network_edges).values(chunk.map((person) => ({
          id: person.edge_id,
          user_id: userId,
          person_id: person.id,
          relationship_type: 'first_degree',
          source: 'linkedin_csv',
          source_import_id: networkImport.id,
          source_timestamp: person.connected_at ? new Date(person.connected_at) : null,
          confidence: 'user_provided',
          created_at: now,
        })));
      }

      const companies = new Map<string, { name: string; edgeIds: string[] }>();
      for (const person of people) {
        if (!person.company_scope_key || !person.company_name) continue;
        const group = companies.get(person.company_scope_key) ?? { name: person.company_name, edgeIds: [] };
        group.edgeIds.push(person.edge_id);
        companies.set(person.company_scope_key, group);
      }
      if (companies.size > 0) {
        const companyRows = Array.from(companies, ([scopeKey, company]) => ({
          user_id: userId,
          company_scope_key: scopeKey,
          company_name: company.name,
          supporting_edge_ids: company.edgeIds,
          connection_count: company.edgeIds.length,
          last_calculated_at: now,
        }));
        for (let index = 0; index < companyRows.length; index += 250) {
          await tx.insert(network_company_matches).values(companyRows.slice(index, index + 250));
        }
      }
      await tx.update(network_imports).set({ status: 'superseded', preview_rows: null }).where(and(
        eq(network_imports.user_id, userId),
        eq(network_imports.status, 'committed'),
        ne(network_imports.id, networkImport.id),
      ));
      await tx.update(network_imports).set({
        status: 'committed',
        preview_rows: null,
        committed_at: now,
      }).where(eq(network_imports.id, networkImport.id));
      });
    } catch (error) {
      return sendCsvError(reply, error);
    }
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send(await readNetworkStatus(userId));
  });

  fastify.delete('/network/linkedin/import/preview/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid import preview id', code: 'invalid_request' });
    const now = new Date();
    const [deleted] = await db.update(network_imports).set({
      status: 'deleted',
      preview_rows: null,
      deleted_at: now,
    }).where(and(
      eq(network_imports.id, parsed.data.id),
      eq(network_imports.user_id, request.jwtPayload!.userId),
      eq(network_imports.status, 'previewed'),
      isNull(network_imports.deleted_at),
    )).returning({ id: network_imports.id });
    if (!deleted) return reply.status(404).send({ error: 'Import preview not found', code: 'import_not_found' });
    return reply.status(200).send({ deleted: true, import_id: deleted.id });
  });

  fastify.post('/network/linkedin/disconnect', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.jwtPayload!.userId;
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`network:${userId}`}, 0::bigint))`);
      await tx.update(network_consents).set({ revoked_at: now }).where(and(
        eq(network_consents.user_id, userId),
        isNull(network_consents.revoked_at),
      ));
      await tx.update(linked_network_accounts).set({
        encrypted_access_token: null,
        encrypted_refresh_token: null,
        refresh_state: 'revoked',
        revoked_at: now,
        updated_at: now,
      }).where(and(eq(linked_network_accounts.user_id, userId), isNull(linked_network_accounts.revoked_at)));
    });
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send(await readNetworkStatus(userId));
  });

  fastify.delete('/network/linkedin/data', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.jwtPayload!.userId;
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`network:${userId}`}, 0::bigint))`);
      await tx.update(network_consents).set({ revoked_at: now }).where(and(
        eq(network_consents.user_id, userId),
        isNull(network_consents.revoked_at),
      ));
      await tx.update(linked_network_accounts).set({
        encrypted_access_token: null,
        encrypted_refresh_token: null,
        refresh_state: 'revoked',
        revoked_at: now,
        updated_at: now,
      }).where(eq(linked_network_accounts.user_id, userId));
      await tx.delete(network_company_matches).where(eq(network_company_matches.user_id, userId));
      await tx.delete(network_edges).where(eq(network_edges.user_id, userId));
      await tx.delete(network_people).where(eq(network_people.user_id, userId));
      await tx.update(network_imports).set({
        status: 'deleted',
        preview_rows: null,
        deleted_at: now,
      }).where(eq(network_imports.user_id, userId));
    });
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send({ deleted: true, ...(await readNetworkStatus(userId)) });
  });

  fastify.get('/network/people', { preHandler: requireAuth }, async (request: FastifyRequest, reply) => {
    const userId = request.jwtPayload!.userId;
    const feature = await requireFeature(userId, 'networking_discovery', 'network_people_read');
    if (!feature.allowed) return reply.status(402).send(feature.denial);
    if (!(await hasActiveLinkedInCsvConsent(userId))) return inactiveNetworkConsentReply(reply);
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', detail: parsed.error.issues });
    const rows = await db.select({
      id: network_people.id,
      first_name: network_people.first_name,
      last_name: network_people.last_name,
      full_name: network_people.full_name,
      profile_url: network_people.profile_url,
      company: network_people.company_name,
      title: network_people.title,
      connected_at: network_people.source_timestamp,
    }).from(network_people).where(and(
      eq(network_people.user_id, userId),
      eq(network_people.source, 'linkedin_csv'),
    )).orderBy(network_people.full_name).limit(parsed.data.limit);
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send({
      people: rows.map((row) => ({
        ...row,
        connected_at: row.connected_at?.toISOString() ?? null,
        relationship: 'First-degree connection',
        source: 'linkedin_csv',
        provenance: 'user_imported',
      })),
    });
  });

  fastify.get('/network/companies', { preHandler: requireAuth }, async (request: FastifyRequest, reply) => {
    const userId = request.jwtPayload!.userId;
    const feature = await requireFeature(userId, 'connected_companies', 'network_companies_read');
    if (!feature.allowed) return reply.status(402).send(feature.denial);
    if (!(await hasActiveLinkedInCsvConsent(userId))) return inactiveNetworkConsentReply(reply);
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', detail: parsed.error.issues });
    const rows = await db.select({
      id: network_company_matches.id,
      name: network_company_matches.company_name,
      connection_count: network_company_matches.connection_count,
      last_calculated_at: network_company_matches.last_calculated_at,
    }).from(network_company_matches).where(eq(network_company_matches.user_id, userId))
      .orderBy(desc(network_company_matches.connection_count), network_company_matches.company_name)
      .limit(parsed.data.limit);
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send({
      companies: rows.map((row) => ({ ...row, last_calculated_at: row.last_calculated_at.toISOString() })),
    });
  });
}
