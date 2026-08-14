import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { artifacts, artifact_versions } from '../db/schema';
import { readApplicationReview } from './applicationReview';
import {
  rerenderFrozenCoverLetter,
  rerenderFrozenResume,
  type FrozenCoverLetterInputs,
  type FrozenResumeInputs,
} from './packetDocumentRecovery';
import { immutableDocumentContentHash } from './immutableDocumentHash';
export { immutableDocumentContentHash } from './immutableDocumentHash';

export type OwnedDownloadSource =
  | { kind: 'resume'; inputs: FrozenResumeInputs }
  | { kind: 'cover_letter'; inputs: FrozenCoverLetterInputs };

export class InvalidImmutableDocumentBindingError extends Error {
  constructor() {
    super('The retained document version failed its immutable content binding');
    this.name = 'InvalidImmutableDocumentBindingError';
  }
}

type FrozenCoverLetterVersion = {
  body?: unknown;
  full_name?: unknown;
  email?: unknown;
  company?: unknown;
  generated_at?: unknown;
};

export type ImmutableDocumentVersionBinding = {
  kind: string;
  structured_content: unknown;
  content_hash: string;
  job_context: unknown;
};

export function sourceFromImmutableVersion(version: ImmutableDocumentVersionBinding): OwnedDownloadSource {
  if (immutableDocumentContentHash(version.structured_content) !== version.content_hash) {
    throw new InvalidImmutableDocumentBindingError();
  }

  if (version.kind === 'resume' || version.kind === 'tailored_resume') {
    const review = readApplicationReview(version.structured_content);
    const job = version.job_context as { role?: string } | null;
    return {
      kind: 'resume',
      inputs: {
        spec: version.structured_content,
        jdText: review?.jd_text ?? '',
        role: review?.role ?? job?.role,
      },
    };
  }

  if (version.kind !== 'cover_letter') throw new InvalidImmutableDocumentBindingError();
  const cover = version.structured_content as FrozenCoverLetterVersion;
  if (typeof cover.full_name === 'string'
    && typeof cover.company === 'string'
    && typeof cover.body === 'string'
    && typeof cover.generated_at === 'string'
    && (cover.email === undefined || typeof cover.email === 'string')) {
    return {
      kind: 'cover_letter',
      inputs: {
        fullName: cover.full_name,
        email: cover.email,
        company: cover.company,
        body: cover.body,
        generatedAt: cover.generated_at,
      },
    };
  }
  throw new InvalidImmutableDocumentBindingError();
}

export async function findOwnedDownloadSource(userId: string, objectKey: string): Promise<OwnedDownloadSource | null> {
  const [version] = await db.select({
    kind: artifacts.kind,
    structured_content: artifact_versions.structured_content,
    content_hash: artifact_versions.content_hash,
    job_context: artifact_versions.job_context,
  }).from(artifact_versions).innerJoin(artifacts, eq(
    artifacts.id,
    artifact_versions.artifact_id,
  )).where(and(
    eq(artifacts.user_id, userId),
    eq(artifact_versions.rendered_object_key, objectKey),
    inArray(artifacts.kind, ['resume', 'tailored_resume', 'cover_letter']),
    isNull(artifacts.deleted_at),
  )).orderBy(desc(artifact_versions.version_number)).limit(1);
  if (!version) return null;
  return sourceFromImmutableVersion(version);
}

export type DownloadRecoveryResult =
  | { status: 'rendered'; kind: 'resume' | 'cover_letter'; buffer: Buffer }
  | { status: 'not_found' }
  | { status: 'unrecoverable' };

export async function recoverOwnedGeneratedDocument(input: {
  userId: string;
  objectKey: string;
  findSource?: (userId: string, objectKey: string) => Promise<OwnedDownloadSource | null>;
  renderResume?: (inputs: FrozenResumeInputs) => Promise<Buffer>;
  renderCoverLetter?: (inputs: FrozenCoverLetterInputs) => Promise<Buffer>;
}): Promise<DownloadRecoveryResult> {
  try {
    const source = await (input.findSource ?? findOwnedDownloadSource)(input.userId, input.objectKey);
    if (!source) return { status: 'not_found' };
    if (source.kind === 'resume') {
      return {
        status: 'rendered',
        kind: 'resume',
        buffer: await (input.renderResume ?? rerenderFrozenResume)(source.inputs),
      };
    }
    return {
      status: 'rendered',
      kind: 'cover_letter',
      buffer: await (input.renderCoverLetter ?? rerenderFrozenCoverLetter)(source.inputs),
    };
  } catch {
    return { status: 'unrecoverable' };
  }
}
