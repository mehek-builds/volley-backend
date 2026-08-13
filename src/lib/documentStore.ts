import { randomUUID } from 'node:crypto';
import { del, put } from '@vercel/blob';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, user_documents } from '../db/schema';
import { DOCUMENT_ENCRYPTION_SCHEME, openDocument, sealDocument } from './documentCrypto';
import { resolveBlobUrl } from './resumeAccess';

export type UserDocumentRow = typeof user_documents.$inferSelect;
export type ApplicationRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

/* The document types this store will accept. A string column rather than an enum in the database,
 * so adding the second one is a value here and not a migration. Keep this list and the route's
 * `kind` validation the same list: an unrecognised kind writing a row would produce a library entry
 * no screen can ever show and no packet can ever attach. */
export const USER_DOCUMENT_KINDS = ['transcript'] as const;
export type UserDocumentKind = typeof USER_DOCUMENT_KINDS[number];

/* THE CAP IS 4 MB, NOT 10, and it is enforced here rather than only in the route so that no future
 * caller can route around it.
 *
 * 10 MB is the size the global multipart limit permits (src/index.ts:165) and it is the number a
 * modal would naturally promise. It is not a number this product can keep. The managed sandbox
 * carries an upload as base64 and refuses any file over 6,000,000 characters, which is about
 * 4.29 MiB decoded, per file, before a browser opens - and there is no request-body limit in front
 * of that check, so a larger body may instead be rejected by the platform with no error envelope at
 * all, indistinguishable from an outage.
 *
 * THE BYTES MEASURED AGAINST THAT CEILING ARE THESE ONES, the plaintext, and not the sealed object
 * this module writes to Blob. The sandbox encodes packet.transcript, and documentBytesFromPointer
 * has already run that buffer through openDocument by the time any runner sees it, so the envelope's
 * 28 bytes never reach the count. 4,000,000 bytes encode to 5,333,336 characters and clear the
 * ceiling with room to spare on every path. An earlier version of this paragraph did the sum on the
 * sealed object, got 5,333,372, and reached the same conclusion by luck; the number is close enough
 * that the mistake survives a sanity check and wrong enough that anyone deriving a different cap
 * from it would be reasoning about bytes no runner ever handles.
 *
 * A promise of 10 MB would be true on direct-Playwright portals and false on managed ones, which is
 * the worst of the three available options. */
export const MAX_USER_DOCUMENT_BYTES = 4_000_000;

/* Refusals a caller is expected to turn into a 4xx with this message shown to the student.
 * Everything else out of this module is a real failure and should surface as one, mirroring the
 * ResumeUploadError split in lib/resumeUpload.ts. */
export class UserDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserDocumentError';
  }
}

/* A stored pointer that names no document of the reading user's. Its own class, and not a generic
 * "that file is unavailable", because the two failures send whoever reads the log to opposite
 * places: an unavailable file is a dead pointer to go and look for in Blob, and this is a read that
 * was refused before any store was touched, on an object that was never this account's to fetch.
 *
 * IT CARRIES NO KEY, and that is not tidiness. This message is written verbatim into a warn line by
 * both prepare paths, and an object key plus the store's stable base URL is permanent
 * unauthenticated access to whoever's file it actually is. Naming the key in the error would put the
 * pointer in a log to escape a hole that exists because pointers escape. */
export class ForeignDocumentPointerError extends Error {
  constructor() {
    super('That attached document is not this account\'s file');
    this.name = 'ForeignDocumentPointerError';
  }
}

/* What a document looks like on the wire. Note what is NOT here: object_key and blob_url.
 *
 * Those two fields are the whole of the access control on the file. Blob objects are written
 * `access: 'public'` because that is the only mode available, so the object key plus the store's
 * stable base URL is permanent unauthenticated access to a student's transcript, and blob_url IS
 * that URL. Neither may appear in any response body, log line or error message. lib/resumeAccess.ts
 * makes the same argument about the download token and encrypts the payload rather than signing it
 * for exactly this reason. */
export type DocumentSummary = {
  id: string;
  kind: string;
  file_name: string;
  byte_size: number;
  reusable: boolean;
  created_at: string;
  last_used_at: string | null;
  deleted_at: string | null;
};

/* What generated_resumes.spec._documents[kind] holds. This one DOES carry object_key, because the
 * packet builder reads the attachment off the spec and needs to fetch the bytes; the spec is server
 * state, not a response body. attachedDocument below is the reader that strips it. */
export type StoredDocumentAttachment = {
  document_id: string | null;
  file_name: string | null;
  object_key: string | null;
  attached_at: string | null;
  ordered_at: string | null;
  employer_label: string | null;
  official_requested: boolean;
};

/** The same attachment as the client is allowed to see it. */
export type AttachedDocument = Omit<StoredDocumentAttachment, 'object_key'> & { kind: string };

/* Structural rather than the whole row, so the list query below can select the eight columns it is
 * allowed to hand out and hit this signature exactly. A `UserDocumentRow` parameter would have
 * forced a cast there, and a cast is how object_key ends up somewhere it should not be. */
type DocumentSummaryFields = Pick<
  UserDocumentRow,
  'id' | 'kind' | 'file_name' | 'byte_size' | 'reusable' | 'created_at' | 'last_used_at' | 'deleted_at'
>;

export function documentSummary(row: DocumentSummaryFields): DocumentSummary {
  return {
    id: row.id,
    kind: row.kind,
    file_name: row.file_name,
    byte_size: row.byte_size,
    reusable: row.reusable,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    deleted_at: row.deleted_at?.toISOString() ?? null,
  };
}

/* Modeled on storedCoverLetter (lib/coverLetterService.ts:26): read the jsonb, prove the shape, and
 * return null rather than a half-populated object when it does not hold. The cover letter's version
 * insists on body, object_key and file_name together, because an artifact missing any of them is
 * one nothing downstream can attach.
 *
 * The equivalent floor here is deliberately lower, and this is the one real departure. A transcript
 * attachment is valid with NO file at all: screen 06's "I've ordered it" records an acknowledgement
 * with document_id and object_key both null, and the row exists precisely so the checklist stops
 * asking. So the shape test is that the record is an object carrying at least one of the two things
 * that can make it real - an attached document, or a recorded order - and anything else is nothing.
 */
function readAttachment(value: unknown): StoredDocumentAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<StoredDocumentAttachment>;
  const documentId = typeof record.document_id === 'string' ? record.document_id : null;
  const orderedAt = typeof record.ordered_at === 'string' ? record.ordered_at : null;
  if (!documentId && !orderedAt) return null;
  return {
    document_id: documentId,
    file_name: typeof record.file_name === 'string' ? record.file_name : null,
    object_key: typeof record.object_key === 'string' ? record.object_key : null,
    attached_at: typeof record.attached_at === 'string' ? record.attached_at : null,
    ordered_at: orderedAt,
    employer_label: typeof record.employer_label === 'string' ? record.employer_label : null,
    official_requested: record.official_requested === true,
  };
}

/** Drop object_key on the way out. The only place that conversion is allowed to happen. */
function publicAttachment(kind: string, attachment: StoredDocumentAttachment): AttachedDocument {
  const { object_key: _objectKey, ...visible } = attachment;
  return { kind, ...visible };
}

/**
 * Every document attached to one application, keyed by kind, in the shape a client may see.
 *
 * Keyed by kind rather than listed, because that is how the spec stores them: a second document
 * type is a new key and never a shape change, so nothing that reads `documents.transcript` today
 * has to learn about arrays tomorrow.
 */
export function storedDocuments(row: ApplicationRow): Record<string, AttachedDocument> {
  const value = (row.spec as StoredSpec)._documents;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, AttachedDocument> = {};
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    const attachment = readAttachment(entry);
    if (attachment) out[kind] = publicAttachment(kind, attachment);
  }
  return out;
}

/** One attached document, in the shape a client may see. */
export function attachedDocument(row: ApplicationRow, kind: string): AttachedDocument | null {
  const value = (row.spec as StoredSpec)._documents;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attachment = readAttachment((value as Record<string, unknown>)[kind]);
  return attachment ? publicAttachment(kind, attachment) : null;
}

/**
 * The whole stored spec, with every Blob pointer taken out of _documents, for a route that answers
 * with the spec itself rather than with one of the readers above.
 *
 * WHY THIS EXISTS AS A FUNCTION AND NOT AS TWO DELETES AT A CALL SITE. storedDocuments and
 * attachedDocument only protect a route that goes looking for a document. GET /resume/history does
 * not: it returns the spec of up to 50 applications whole, so it shipped object_key without any
 * route ever mentioning documents, and the contract test that fences documents.ts could not see it.
 * A third route that answers with a spec will make the same mistake in the same invisible way, and
 * the only defence that scales is one named conversion for "a spec, on the wire".
 *
 * IT WAS WRITTEN FOR ONE ROUTE AND THE OTHER THREE WERE STILL LEAKING, which is the whole argument
 * for it being a chokepoint rather than a patch. The re-check found GET
 * /applications/:id/submission/extension-packet handing the raw spec to a content script in the
 * employer's page origin, and GET /account/export spreading every generated_resumes row whole into
 * a file the student is expected to save and forward. Neither mentions documents anywhere. The four
 * callers now are: routes/resume.ts (history, and the generate response), routes/applications.ts
 * (the extension packet, and the resume edit), routes/account.ts (the export). Any new route that
 * answers with a stored spec is the fifth, and documentResponseContract.test.ts is what makes it
 * say so.
 *
 * It returns the argument UNTOUCHED when there is nothing to strip, which is nearly every row. That
 * is deliberate on a fifty-row payload: db/schema.ts:1122 records a board list query exhausting
 * Neon's 5 GB monthly transfer ceiling, and this path is the one the plan flagged for the same
 * reason. Copying every spec to change none of them would be pure cost.
 *
 * It reaches exactly one level in, the per-kind attachment, because that is the whole of the shape
 * the spec stores. A recursive scrub would also strip _cover_letter.object_key and change what the
 * history route hands its own download-link builder, which is a separate decision with a separate
 * blast radius.
 */
export function specWithoutDocumentPointers(spec: unknown): unknown {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const record = spec as Record<string, unknown>;
  const documents = record._documents;
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return spec;
  const scrubbed: Record<string, unknown> = {};
  for (const [kind, entry] of Object.entries(documents as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      scrubbed[kind] = entry;
      continue;
    }
    // blob_url is not a field anything writes to the spec today. It is stripped anyway, because the
    // cost is one line and the thing it guards against is a future writer copying a row across.
    const { object_key: _objectKey, blob_url: _blobUrl, ...visible } = entry as Record<string, unknown>;
    scrubbed[kind] = visible;
  }
  return { ...record, _documents: scrubbed };
}

/**
 * Where a student's own uploads live: users/<id>/documents/<uuid>.pdf.
 *
 * Every segment of that is load-bearing against lib/resumeAccess.ts, verified there rather than
 * assumed. Under users/<id>/ so deleteBlobsForUser takes it on account deletion with no new code,
 * which its header comment says is exactly what the owner-scoped prefix is for. NOT at the user
 * root, so isUploadedResumeBlob does not match it - that regex allows no extra path segment. NOT
 * under /resumes/, so the generated-resume rule does not match it either.
 *
 * AND, SINCE THOSE TWO EXCLUSIONS ARE ONLY HALF OF IT, `documents/` IS ITS OWN CLASSIFICATION. Not
 * matching the delete rules once meant landing in the catch-all, which is kept today and is
 * explicitly the arm a future decision is expected to give a window. classifyUserBlob answers this
 * shape with 'user-document' and retentionDaysForCategory exempts it by name, so the retention
 * promise - this file is kept until she removes it, where a generated resume is swept after 30 days
 * - rests on a decision rather than on a default.
 */
export function userDocumentObjectKey(userId: string): string {
  return `users/${userId}/documents/${randomUUID()}.pdf`;
}

export type PutUserDocumentInput = {
  userId: string;
  kind: UserDocumentKind;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  reusable: boolean;
  firstApplicationId?: string | null;
};

/**
 * Seal the bytes, write them to Blob, then record the row. Returns the stored row, so the caller can
 * build both the summary it answers with and the spec attachment it writes.
 *
 * ORDER, AND WHY THE BLOB IS DELETED ON A DATABASE FAILURE. put() first means a failed insert leaves
 * an orphan object that nothing points at and that no sweep will ever collect, since this prefix is
 * deliberately outside both arms of the retention sweep. persistCoverLetter answers that by deleting
 * the blob inside the catch before rethrowing (lib/coverLetterService.ts:102), and this mirrors it
 * exactly. The reverse order is not available: the row needs object_key and blob_url, and both of
 * those are things put() returns rather than things we choose.
 */
export async function putUserDocument(input: PutUserDocumentInput): Promise<UserDocumentRow> {
  if (!USER_DOCUMENT_KINDS.includes(input.kind)) {
    throw new UserDocumentError('Unsupported document kind.');
  }
  if (input.bytes.length === 0) {
    throw new UserDocumentError('That file is empty.');
  }
  if (input.bytes.length > MAX_USER_DOCUMENT_BYTES) {
    throw new UserDocumentError('That file is larger than the 4 MB limit.');
  }

  const objectKey = userDocumentObjectKey(input.userId);
  const blob = await put(objectKey, sealDocument(input.bytes), {
    access: 'public',
    // The stored bytes are ciphertext, not a PDF. Declaring application/pdf here would be a lie the
    // store then serves as a Content-Type header, and a browser that follows a leaked URL would be
    // handed an unreadable "PDF" instead of an obvious opaque download.
    contentType: 'application/octet-stream',
  });

  let rows: UserDocumentRow[];
  try {
    rows = await db.insert(user_documents).values({
      user_id: input.userId,
      kind: input.kind,
      file_name: input.fileName,
      content_type: input.contentType,
      // The plaintext length, which is the number she is shown. The object is 28 bytes longer.
      byte_size: input.bytes.length,
      // put() assigns the pathname; addRandomSuffix defaults to true, so the key it returns is NOT
      // the key it was asked for. Storing the requested one is the bug that made resolveBlobUrl
      // return null for every resume ever generated (lib/resumeAccess.ts:164 records it).
      object_key: blob.pathname,
      blob_url: blob.url,
      encryption_scheme: DOCUMENT_ENCRYPTION_SCHEME,
      reusable: input.reusable,
      first_application_id: input.firstApplicationId ?? null,
    }).returning();
  } catch (error) {
    await del(blob.url).catch(() => undefined);
    throw error;
  }
  if (!rows[0]) {
    await del(blob.url).catch(() => undefined);
    throw new Error('The document could not be saved');
  }
  return rows[0];
}

type DocumentBytesDependencies = {
  resolveObjectUrl: (objectKey: string) => Promise<string | null>;
  fetchObject: (url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>;
};

/**
 * Fetch and unseal one document from the pointers stored beside it.
 *
 * READS blob_url FIRST, AND THAT ORDERING IS THE POINT OF THE COLUMN. resolveBlobUrl goes through
 * list({ prefix }), which is eventually consistent with no stated bound: reproduced server-side
 * 404ing 54 seconds after the write, and R-040 was every Ashby fill of 2026-07-18 shipping without
 * a resume because of it. A transcript uploaded and attached in the same sitting is precisely the
 * window that loses, and the failure is silent - a missing file reads as "deleted", not as an
 * error. The URL exists at write time for free, so it is a column, and the resolver is only the
 * fallback for a row written before that column existed or a URL the store has since reissued.
 */
export async function documentBytesFromPointer(
  pointer: { blobUrl: string | null; objectKey: string },
  dependencies: DocumentBytesDependencies = {
    resolveObjectUrl: resolveBlobUrl,
    fetchObject: (url) => fetch(url),
  },
): Promise<Buffer> {
  const url = pointer.blobUrl || (await dependencies.resolveObjectUrl(pointer.objectKey));
  if (!url) throw new Error('That file is unavailable');
  const response = await dependencies.fetchObject(url);
  if (!response.ok) throw new Error('That file could not be downloaded');
  return openDocument(Buffer.from(await response.arrayBuffer()));
}

/* THERE IS DELIBERATELY NO getUserDocumentBytes(userId, documentId) HERE.
 *
 * It was written, exported, and never called by anything. Deleted rather than kept, because of what
 * the shape of it invites. A reader keyed by DOCUMENT ID, filtered to live rows, returning plaintext
 * is the exact signature a download endpoint needs, and this product does not have one and should
 * not grow one by accident: nothing in Litos ever opens these files, and the only place their bytes
 * are supposed to go is an employer's form.
 *
 * The one path that does need the bytes is the packet builder, and it cannot use that shape anyway.
 * documentBytesForPacket (routes/submissionRunner.ts) keys on the OBJECT KEY, because the key is
 * what the spec carries, and it deliberately does not exclude tombstones, because a sent application
 * still points at the file it sent. Two different questions; one of them has a caller.
 */

/**
 * This user's live documents, newest use first, tombstones excluded.
 *
 * Ordered by coalesce(last_used_at, created_at) because that is the order both readers want: it is
 * "last used" in Profile > Documents, and it is the pick order for reusing a file on the next
 * application without asking. Selecting columns explicitly rather than the whole row keeps
 * object_key and blob_url out of anything a caller could accidentally serialize.
 */
export async function listUserDocuments(
  userId: string,
  options: { kind?: string } = {},
): Promise<DocumentSummary[]> {
  const rows = await db.select({
    id: user_documents.id,
    kind: user_documents.kind,
    file_name: user_documents.file_name,
    byte_size: user_documents.byte_size,
    reusable: user_documents.reusable,
    created_at: user_documents.created_at,
    last_used_at: user_documents.last_used_at,
    deleted_at: user_documents.deleted_at,
  })
    .from(user_documents)
    .where(and(
      eq(user_documents.user_id, userId),
      isNull(user_documents.deleted_at),
      ...(options.kind ? [eq(user_documents.kind, options.kind)] : []),
    ))
    .orderBy(desc(sql`coalesce(${user_documents.last_used_at}, ${user_documents.created_at})`));
  return rows.map((row) => documentSummary(row));
}

/* What a reuse needs to know about the file it is about to attach, and nothing else. object_key is
 * here because the spec attachment carries it and the packet builder fetches by it; this record
 * never reaches a response. */
export type ReusableDocument = {
  id: string;
  file_name: string;
  object_key: string;
};

/* WHETHER THIS FILE IS STILL HERS TO REUSE, in one place, because both statements below ask it.
 *
 * `reusable = true` IS A FILTER AND NOT A PREFERENCE. She unticked the box on the upload modal to
 * say that file was for one employer, and a fallback to "take it anyway if nothing else matches"
 * would be the checkbox doing nothing. There is no second pick: no reusable file means no reuse and
 * she is asked, which is the state the product was in for every upload before reuse existed.
 *
 * `deleted_at is null` for the reason the library list has it: a tombstone's blob is already gone,
 * so attaching one would leave an application pointing at nothing, which the packet builder degrades
 * into a send with no document and a named blocker. */
function reusableForKind(userId: string, kind: string) {
  return and(
    eq(user_documents.user_id, userId),
    eq(user_documents.kind, kind),
    eq(user_documents.reusable, true),
    isNull(user_documents.deleted_at),
  );
}

/**
 * The file the next application asking for this kind should get.
 *
 * NEWEST USE FIRST, `coalesce(last_used_at, created_at) desc`, the same order Profile > Documents
 * shows. Two orders would mean the file at the top of the list she is looking at is not the file the
 * next application picks.
 *
 * Exported unawaited so the predicate can be compiled and read without a database. `reusable` was
 * written on every upload and read as a filter by nothing for the whole life of the column, so the
 * assertion that has to exist is that this statement names it.
 */
export function reusableDocumentQuery(userId: string, kind: string) {
  return db.select({ id: user_documents.id })
    .from(user_documents)
    .where(reusableForKind(userId, kind))
    .orderBy(desc(sql`coalesce(${user_documents.last_used_at}, ${user_documents.created_at})`))
    .limit(1);
}

/**
 * The file to attach to the next application that asks for this kind, claimed for that use.
 *
 * THE WHOLE POINT OF STORING A DOCUMENT RATHER THAN FORWARDING IT. `reusable` has been written on
 * every upload since the column existed and read as a filter by nothing, while the modal's checkbox
 * said "Reuse this for future applications that ask" and /privacy published "so a later application
 * can use the same file without us asking you for it again". This is what makes both true.
 *
 * STAMPED IN A SECOND STATEMENT GUARDED BY THE SAME PREDICATE, and the guard is what makes the read
 * safe rather than the read itself. A removal landing between the select and the update loses the
 * update, and this returns null rather than handing back a pointer to a blob that has just been
 * deleted. That is the same shape POST /applications/:id/documents/attach uses, where the stamp and
 * the ownership check are one statement because the id is already known.
 */
export async function claimReusableDocument(userId: string, kind: string): Promise<ReusableDocument | null> {
  const [candidate] = await reusableDocumentQuery(userId, kind);
  if (!candidate) return null;

  const claimed = await db.update(user_documents).set({
    // What "last used" means on the account card, and the pick order for the application after this
    // one. A reuse that did not stamp it would leave the same file at the same place in the order
    // forever and tell her it had never been used.
    last_used_at: new Date(),
    updated_at: new Date(),
  }).where(and(
    eq(user_documents.id, candidate.id),
    // The SAME predicate the pick used, not a restatement of it. Two copies of "is this file still
    // hers to reuse" is how one of them stops mentioning `reusable` a year from now.
    reusableForKind(userId, kind),
  )).returning({
    id: user_documents.id,
    file_name: user_documents.file_name,
    object_key: user_documents.object_key,
  });
  return claimed[0] ?? null;
}

/**
 * Remove the file and mark the row dead. Returns false when there is no live document of that id
 * for this user, which covers both "never existed" and "already removed".
 *
 * THE BLOB GOES FIRST, AND THE ROW IS ONLY MARKED IF IT WENT. That order is chosen for what each
 * failure leaves behind. If the delete fails and this throws, the row stays live, so she sees the
 * file still listed and a retry can still find it: honest, and recoverable. The other order can
 * mark the row dead while the object survives, and at that point nothing in the system points at a
 * public, permanently readable copy of her transcript - the privacy sentence would be false with no
 * way left to make it true. A row marked dead whose blob is already gone is the lesser failure and
 * the only one this can produce: the pointers are dead by definition at that point, and a read of
 * a tombstone is already a miss.
 *
 * TOMBSTONE, NOT DELETE. A sent application still has to be able to say what went out with it, and
 * reusable is cleared alongside so no later application can pick a file that no longer exists.
 */
export async function tombstoneUserDocument(userId: string, documentId: string): Promise<boolean> {
  const [row] = await db.select({
    object_key: user_documents.object_key,
    blob_url: user_documents.blob_url,
  })
    .from(user_documents)
    .where(and(
      eq(user_documents.id, documentId),
      eq(user_documents.user_id, userId),
      isNull(user_documents.deleted_at),
    ))
    .limit(1);
  if (!row) return false;

  const url = row.blob_url || (await resolveBlobUrl(row.object_key).catch(() => null));
  // A row whose object cannot be located at all is already in the state this function is trying to
  // reach, so the tombstone still goes down. A del() that FAILS is different and is allowed to
  // throw: that is a file still sitting in public storage.
  if (url) await del(url);

  const updated = await db.update(user_documents).set({
    deleted_at: new Date(),
    reusable: false,
    updated_at: new Date(),
  })
    .where(and(
      eq(user_documents.id, documentId),
      eq(user_documents.user_id, userId),
      isNull(user_documents.deleted_at),
    ))
    .returning({ id: user_documents.id });
  return updated.length > 0;
}
