import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { generated_resumes, user_documents } from '../db/schema';
import {
  attachedDocument,
  documentSummary,
  listUserDocuments,
  putUserDocument,
  tombstoneUserDocument,
  MAX_USER_DOCUMENT_BYTES,
  USER_DOCUMENT_KINDS,
  UserDocumentError,
  type ApplicationRow,
  type AttachedDocument,
  type StoredDocumentAttachment,
  type UserDocumentKind,
} from '../lib/documentStore';
import { inspectResumeUpload, type ResumeUploadMetadata } from '../lib/resumeUpload';
import { requireAuth } from '../middleware/auth';

/* The HTTP surface for the files a student attaches to an application herself.
 *
 * EVERY ROUTE IN THIS FILE CARRIES `{ preHandler: requireAuth }`, and that is not a convention, it
 * is the whole access control. There is no global auth hook and no auth decorator in this app
 * (middleware/auth.ts:142 is a plain preHandler function), so a route declared without it is
 * silently public and answers with somebody else's transcript. documentResponseContract.test.ts
 * counts the route declarations against the preHandler mentions so a new one cannot be added
 * without it.
 *
 * Litos never reads inside these files. No grade, no GPA, no text extraction: a transcript is
 * stored as opaque ciphertext and handed to the employer's form exactly as she handed it over.
 */

const applicationParamsSchema = z.object({ id: z.string().uuid() });
const kindParamsSchema = z.object({ kind: z.enum(USER_DOCUMENT_KINDS) });
const documentParamsSchema = z.object({ id: z.string().uuid() });
const attachBodySchema = z.object({
  document_id: z.string().uuid(),
  kind: z.enum(USER_DOCUMENT_KINDS),
});
const orderedBodySchema = z.object({ kind: z.enum(USER_DOCUMENT_KINDS) });

/* The employer's own wording for what it asked for, kept so the modal can say why she is being
 * asked. Clipped because this value rides on generated_resumes.spec, and /resume/history returns
 * the whole spec for up to 50 rows (routes/resume.ts): a board list query has already cost this
 * project Neon's entire 5 GB monthly transfer allowance once, and the comment at schema.ts:1122 is
 * the record of it. The label is also NOT verbatim by the time it reaches here - fieldLabel.ts:99
 * already truncated it to 120 characters - so no copy anywhere may promise a quotation.
 */
const EMPLOYER_LABEL_MAX_CHARS = 200;

/* The one sentence this surface refuses an oversized file with. lib/documentStore.ts answers with
 * the same words from the store, on purpose: that copy exists so no future caller can route around
 * the cap by not being this route, and this one exists so the bytes are never held in the first
 * place. */
const OVER_CAP_MESSAGE = 'That file is larger than the 4 MB limit.';

/**
 * What to tell a student when the multipart iterator throws.
 *
 * THE 10 MB PLUGIN LIMIT AND THE 4 MB DOCUMENT CAP ARE TWO DIFFERENT REFUSALS AND ONLY ONE OF THEM
 * USED TO SAY SO. The `fileSize` limit at index.ts:166 is global, shared with the resume upload, and
 * two and a half times this surface's cap; @fastify/multipart raises it from inside `part.file`, so
 * it lands in the same catch as a genuinely malformed body. A file between 4 MB and 10 MB therefore
 * got the sentence naming the limit, from the counter below, and a file over 10 MB got "Failed to
 * parse multipart form data" - the larger the file, the less true the refusal, and the only one of
 * the two that reads as a Litos fault is the one where she did nothing wrong but pick a big scan.
 *
 * The modal refuses at 4 MB before a byte is sent, so this is not the path a student on the website
 * takes. It is the path everything else takes, and a public HTTP surface owes the same sentence to
 * all of them.
 *
 * FST_FILES_LIMIT is deliberately NOT folded in here. More than one file part is a client that built
 * the form wrong, not a student with a large transcript, and telling her about a size cap she has
 * not hit would send her to shrink a file that was never the problem.
 *
 * Exported so the branch is tested by calling it. A source-text test cannot tell a correct branch
 * from a deleted one, and reaching this one over HTTP costs a database, a signed token and an
 * 11 MB request body for one string.
 */
export function multipartFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'FST_REQ_FILE_TOO_LARGE' ? OVER_CAP_MESSAGE : 'Failed to parse multipart form data';
}

async function ownedApplication(request: FastifyRequest, reply: FastifyReply): Promise<ApplicationRow | null> {
  const parsed = applicationParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id' });
    return null;
  }
  const rows = await db.select().from(generated_resumes).where(and(
    eq(generated_resumes.id, parsed.data.id),
    eq(generated_resumes.user_id, request.jwtPayload!.userId),
  )).limit(1);
  if (!rows[0]) {
    reply.status(404).send({ error: 'Application not found' });
    return null;
  }
  return rows[0];
}

/* PDF only, decided by inspectResumeUpload (lib/resumeUpload.ts:84) and then narrowed to the one
 * format this surface accepts.
 *
 * Calling it rather than restating its rule is deliberate. It is the function that already knows a
 * renamed file is a conflict and not a hint, that a browser submitting a blank or generic content
 * type is advisory rather than wrong, and that ISO 32000 permits the %PDF- header anywhere in the
 * first 1024 bytes. What is NOT reused is its copy: every message it throws offers DOCX as well,
 * and this surface does not accept DOCX, so all three of its refusals collapse into the one
 * sentence the student can act on.
 */
function isPdfUpload(bytes: Buffer, metadata: ResumeUploadMetadata): boolean {
  try {
    return inspectResumeUpload(bytes, metadata) === 'pdf';
  } catch {
    return false;
  }
}

/* The name the employer's form will see.
 *
 * This string is client-supplied and it does not stay inside Litos: WI-5 carries it to Playwright's
 * setInputFiles, to the managed sandbox's upload action, and into the Content-Disposition of a
 * multipart part posted to an ATS API. A path separator, a control character or a CR/LF in it is
 * therefore not a cosmetic problem. Basename only, printable characters only, and a real fallback
 * so an upload with no filename at all still attaches under a name that says what it is.
 */
function safeDocumentFileName(filename: string | undefined, kind: string): string {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${kind}.pdf`;
}

/**
 * Write one document into `spec._documents[kind]` and read back what was persisted.
 *
 * THE PATH IS `{_documents}` AND THE NEW ENTRY IS MERGED IN, never `{_documents,transcript}`.
 * jsonb_set with create_missing only creates the LAST element of the path, so on the spec of an
 * application that has never had a document - which is every application today - the nested form is
 * a silent no-op that returns the spec unchanged and reports one row updated. Measured against
 * Postgres before this was written: jsonb_set('{"a":1}', '{_documents,transcript}', '{"x":1}',
 * true) returns exactly {"a":1}. The student would have seen an upload succeed and the row keep
 * asking. The `||` merge also keeps every other kind, so a second document type stays a new key
 * and never a shape change.
 *
 * Returns null when no row matched, which is the concurrent-deletion case, and returns the shape
 * the client is allowed to see rather than the shape that was written: attachedDocument is the one
 * reader that strips object_key, so the response cannot carry a Blob pointer by construction.
 */
async function writeAttachment(
  row: ApplicationRow,
  kind: string,
  attachment: StoredDocumentAttachment,
): Promise<AttachedDocument | null> {
  const updated = await db.update(generated_resumes).set({
    spec: sql`jsonb_set(
      coalesce(${generated_resumes.spec}, '{}'::jsonb),
      '{_documents}',
      coalesce(${generated_resumes.spec} -> '_documents', '{}'::jsonb) || ${JSON.stringify({ [kind]: attachment })}::jsonb,
      true
    )`,
  }).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
  )).returning();
  if (!updated[0]) return null;
  return attachedDocument(updated[0], kind);
}

/* The object key of whatever is currently attached, read off the spec rather than off
 * attachedDocument, which strips it. Server state only: it never reaches a response, because every
 * response in this file is built by attachedDocument or documentSummary.
 */
function storedObjectKey(row: ApplicationRow, kind: string): string | null {
  const documents = (row.spec as Record<string, unknown>)._documents;
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return null;
  const entry = (documents as Record<string, unknown>)[kind];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const key = (entry as { object_key?: unknown }).object_key;
  return typeof key === 'string' ? key : null;
}

export async function documentRoutes(fastify: FastifyInstance) {
  /* POST /applications/:id/documents - the upload behind the ask modal.
   *
   * THE CAP IS 4 MB, NOT THE 10 MB THE MULTIPART PLUGIN ALLOWS (index.ts:165, global and shared
   * with the resume upload, so it is not this route's to lower). The reason is the managed sandbox:
   * it carries an upload to the browser as base64 and refuses any file over 6,000,000 characters,
   * which is about 4.29 MiB decoded, before a browser opens - and there is no request-body limit in
   * front of that check, so a larger body may instead be rejected by the platform with no error
   * envelope at all, indistinguishable from an outage. A 10 MB promise would hold on direct
   * Playwright portals and be a lie on managed ones.
   */
  fastify.post('/applications/:id/documents', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const row = await ownedApplication(request, reply);
    if (!row) return;

    let documentBytes: Buffer | null = null;
    let documentFilename: string | undefined;
    let documentMimetype: string | undefined;
    let overCap = false;
    let kind: string | undefined;
    let reuse: string | undefined;
    let employerLabel: string | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'document') {
          documentFilename = part.filename;
          documentMimetype = part.mimetype;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of part.file) {
            size += chunk.length;
            // Stop KEEPING bytes at our own cap rather than at the plugin's, so a 10 MB body costs
            // 4 MB of memory instead of 10. The stream is still read to the end: an unconsumed
            // part leaves busboy waiting on backpressure and the request hangs, which reads to the
            // student as a frozen upload rather than as the refusal it is.
            if (size > MAX_USER_DOCUMENT_BYTES) {
              overCap = true;
              continue;
            }
            chunks.push(chunk);
          }
          documentBytes = Buffer.concat(chunks);
        } else if (part.type === 'file') {
          // A file part under any other name is not ours, and it still has to be drained for the
          // same reason as above before the iterator will hand over the next part.
          for await (const _chunk of part.file) { /* discarded */ }
        } else if (part.fieldname === 'kind') {
          kind = part.value as string;
        } else if (part.fieldname === 'reuse') {
          reuse = part.value as string;
        } else if (part.fieldname === 'employer_label') {
          employerLabel = (part.value as string).slice(0, EMPLOYER_LABEL_MAX_CHARS);
        }
      }
    } catch (err) {
      // Also how the global 10 MB file limit and the one-file limit surface, since both throw from
      // inside the iterator. POST /profile answers the same way (routes/profile.ts:718) because it
      // has no cap of its own below the plugin's; this one does, so the size refusal is separated
      // back out rather than served as a parse failure. See multipartFailureMessage.
      fastify.log.error(err);
      return reply.status(400).send({ error: multipartFailureMessage(err) });
    }

    // Everything is validated after the whole form is read, because part order is the client's
    // choice: a browser that puts the file before the fields is normal, not malformed.
    //
    // Size is answered BEFORE emptiness. The bytes held for an over-cap upload are whatever arrived
    // before the cap was crossed, and on a chunking that crosses it immediately that is nothing at
    // all, which the emptiness check would report as a file she did not attach.
    if (overCap) {
      return reply.status(400).send({ error: OVER_CAP_MESSAGE });
    }
    if (!documentBytes || documentBytes.length === 0) {
      return reply.status(400).send({ error: 'document file is required' });
    }
    if (!kind || !(USER_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      return reply.status(400).send({ error: 'Unsupported document kind.' });
    }
    if (!isPdfUpload(documentBytes, { filename: documentFilename, mimetype: documentMimetype })) {
      fastify.log.info({ documentFilename, documentMimetype }, 'rejected non-PDF document upload');
      return reply.status(400).send({ error: 'Upload a PDF.' });
    }

    let document;
    try {
      document = await putUserDocument({
        userId,
        kind: kind as UserDocumentKind,
        fileName: safeDocumentFileName(documentFilename, kind),
        // The verified type, not the declared one. isPdfUpload has just read the bytes; a browser
        // that submitted application/octet-stream or nothing at all should not leave this column
        // recording a claim we already know the answer to.
        contentType: 'application/pdf',
        bytes: documentBytes,
        // The checkbox on the modal ships default ON, so only the literal "false" turns it off and
        // an absent field means the checkbox as she saw it.
        reusable: reuse !== 'false',
        firstApplicationId: row.id,
      });
    } catch (err) {
      if (err instanceof UserDocumentError) return reply.status(400).send({ error: err.message });
      fastify.log.error(err);
      return reply.status(500).send({ error: 'The document could not be saved' });
    }

    // Anything already recorded against this kind survives the upload. She may have pressed "I've
    // ordered it" on the official variant first, and that acknowledgement is still true once the
    // unofficial copy is attached; dropping it would ask her the same question again.
    const previous = attachedDocument(row, kind);
    const stored = await writeAttachment(row, kind, {
      document_id: document.id,
      file_name: document.file_name,
      object_key: document.object_key,
      attached_at: new Date().toISOString(),
      ordered_at: previous?.ordered_at ?? null,
      employer_label: employerLabel || previous?.employer_label || null,
      official_requested: previous?.official_requested ?? false,
    });
    if (!stored) {
      // The blob is deliberately NOT deleted here, unlike the insert failure inside putUserDocument.
      // The user_documents row exists and points at it, so the file is in her library rather than
      // orphaned: GET /documents lists it and DELETE /documents/:id can still remove it.
      return reply.status(409).send({ error: 'Application changed before the document could be saved' });
    }
    return reply.send({ document: documentSummary(document), attachment: stored });
  });

  /* POST /applications/:id/documents/attach - reuse a file already in the library.
   *
   * Ships now and is what auto-reuse in review will call: the whole point of storing a document
   * rather than a per-application upload is that the second application does not have to ask.
   */
  fastify.post('/applications/:id/documents/attach', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const row = await ownedApplication(request, reply);
    if (!row) return;
    const parsed = attachBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid document attachment request' });

    /* One statement stamps last_used_at and answers the ownership question at the same time.
     *
     * A read followed by an update would give a removal running beside it a window to land in
     * between, and the loser of that race is an application holding a pointer to a blob that has
     * already been deleted. The where clause is the whole check: another user's id, another kind,
     * a tombstoned row, or a file she said was for one application all update nothing, and all four
     * are a 404 rather than a message that tells the caller which of the four it was.
     *
     * `reusable = true` IS ONE OF THE FOUR, and it is here because the client asking is not the
     * authority on it. The checkbox on the upload modal ships default ON, and unticking it is told
     * back to her as "Attached to this application only. Litos will ask again the next time an
     * employer wants one." This endpoint is the only way a stored file reaches a SECOND application
     * from outside the server, so without this term that sentence is true only for as long as no
     * client posts the id - and claimReusableDocument (lib/documentStore.ts), the server's own reuse
     * path, has enforced it since it was written. One rule, both doors.
     *
     * THE CASE THIS DELIBERATELY REFUSES is re-attaching a non-reusable file to the very application
     * it was uploaded for, after a detach. Nothing ships that flow: the modal's re-attach is a fresh
     * upload, and there is no library picker on any surface. If one is ever built, the honest fix is
     * to let her change her mind about the checkbox on the file, not to let an attach ignore it.
     */
    const claimed = await db.update(user_documents).set({
      last_used_at: new Date(),
      updated_at: new Date(),
    }).where(and(
      eq(user_documents.id, parsed.data.document_id),
      eq(user_documents.user_id, userId),
      eq(user_documents.kind, parsed.data.kind),
      eq(user_documents.reusable, true),
      isNull(user_documents.deleted_at),
    )).returning({
      file_name: user_documents.file_name,
      object_key: user_documents.object_key,
    });
    if (!claimed[0]) return reply.status(404).send({ error: 'Document not found' });

    const previous = attachedDocument(row, parsed.data.kind);
    const stored = await writeAttachment(row, parsed.data.kind, {
      document_id: parsed.data.document_id,
      file_name: claimed[0].file_name,
      object_key: claimed[0].object_key,
      attached_at: new Date().toISOString(),
      ordered_at: previous?.ordered_at ?? null,
      employer_label: previous?.employer_label ?? null,
      official_requested: previous?.official_requested ?? false,
    });
    if (!stored) return reply.status(409).send({ error: 'Application changed before the document could be saved' });
    return reply.send({ attachment: stored });
  });

  /* DELETE /applications/:id/documents/:kind - detach, and only detach.
   *
   * Mirrors DELETE /applications/:id/cover-letter (routes/coverLetter.ts:74) in shape and departs
   * from it in exactly one way: that route deletes the blob too, because a cover letter belongs to
   * one application and nothing else will ever point at it. This one must not. The file is a
   * library file, another application may already carry it, and she was told it is kept until she
   * removes it. Removing it is DELETE /documents/:id, which is a different sentence and a
   * different button.
   */
  fastify.delete('/applications/:id/documents/:kind', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const row = await ownedApplication(request, reply);
    if (!row) return;
    const parsed = kindParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Unsupported document kind.' });

    // `#-` deletes a path and is a no-op when the path is absent, so detaching twice is not an
    // error, and the kind travels as a bound parameter rather than as text spliced into the path.
    await db.update(generated_resumes).set({
      spec: sql`${generated_resumes.spec} #- ARRAY['_documents', ${parsed.data.kind}]::text[]`,
    }).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    ));
    return reply.send({ attachment: null });
  });

  /* POST /applications/:id/documents/ordered - "I've ordered it", on the official variant.
   *
   * THIS DOES NOT UNBLOCK THE SEND, and that is the design rather than an omission. Litos cannot
   * make a registrar send a sealed transcript to an employer, so the only honest thing this can
   * record is that she was asked and has answered: the row stops nagging, and the application stays
   * where it was. Making it unblock the send would mean submitting an application the employer is
   * going to reject for a missing document, and telling her it went out cleanly.
   */
  fastify.post('/applications/:id/documents/ordered', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const row = await ownedApplication(request, reply);
    if (!row) return;
    const parsed = orderedBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Unsupported document kind.' });

    // Any file already attached is left exactly where it is. The control is only offered on the
    // official variant, so pressing it is an additional fact about this application and never a
    // reason to detach the unofficial copy the packet is about to send.
    const previous = attachedDocument(row, parsed.data.kind);
    const stored = await writeAttachment(row, parsed.data.kind, {
      document_id: previous?.document_id ?? null,
      file_name: previous?.file_name ?? null,
      // Preserved through the client-visible reader, which does not carry object_key, so it is read
      // off the spec directly. A record with a document_id and no key is one the packet builder
      // cannot fetch, and it would look like a file that silently failed to attach.
      object_key: storedObjectKey(row, parsed.data.kind),
      attached_at: previous?.attached_at ?? null,
      ordered_at: new Date().toISOString(),
      employer_label: previous?.employer_label ?? null,
      // Pressing this button is the record that an OFFICIAL copy was asked for: it is the only
      // control that sets this, because it is the only control the official variant shows.
      official_requested: true,
    });
    if (!stored) return reply.status(409).send({ error: 'Application changed before the document could be saved' });
    return reply.send({ attachment: stored });
  });

  /* GET /documents - the library. Tombstones excluded by listUserDocuments, newest use first. */
  fastify.get('/documents', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    return reply.send({ documents: await listUserDocuments(userId) });
  });

  /* DELETE /documents/:id - remove the file.
   *
   * THIS ENDPOINT IS WHAT MAKES THE PRIVACY SENTENCE TRUE. The page promises "we encrypt it and
   * keep it until you remove it or delete your account", and users/<id>/documents/ classifies as
   * 'user-document', which retentionDaysForCategory (lib/resumeAccess.ts) exempts from the age sweep
   * by name, so nothing in the system will ever delete this file on its own. Removal has to be
   * reachable from the shipped UI or the sentence is false.
   *
   * IT IS REACHED FROM TWO PLACES AND ONLY ONE OF THEM IS THE ONE THE PROMISE RESTS ON. The website
   * calls this from Profile > Documents (components/app/DocumentsCard.tsx, on the settings page
   * under #documents, which is where /dashboard/profile lands), and from the attached state of the
   * ask modal (components/app/TranscriptModal.tsx, the "Remove this file" secondary).
   *
   * The account card is the one that counts. The modal opens from a control on an application
   * screen, and an application reaching a terminal status stops drawing any document control at all
   * while the file stays stored - which is the ordinary end of a sent application, not an edge case,
   * so a promise resting on the modal alone would be untrue for most of a stored file's life. That
   * card was built after this comment first claimed the modal was enough; the modal's control is
   * kept because it is where she is looking when she wants it, not because it is the guarantee.
   *
   * The blob goes first and the row is only tombstoned if it went (lib/documentStore.ts:348), so a
   * failure leaves the file listed and retryable rather than leaving a public copy nothing points
   * at. Any application that already sent this document keeps its spec pointer, dead, so a sent
   * application can still name what went out with it.
   */
  fastify.delete('/documents/:id', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const parsed = documentParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid document id' });
    const removed = await tombstoneUserDocument(userId, parsed.data.id);
    if (!removed) return reply.status(404).send({ error: 'Document not found' });
    return reply.send({ deleted: true });
  });
}
