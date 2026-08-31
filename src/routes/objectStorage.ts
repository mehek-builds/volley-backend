import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isPublicObjectKey,
  publicLogoContentType,
  publicLogoObjectKey,
  readObject,
  readObjectReadToken,
} from '../lib/objectStorage';

export type ObjectStorageRouteDependencies = {
  readObject: (key: string) => Promise<Buffer | null>;
  readObjectReadToken: (token: string) => string | null;
};

const defaultDependencies: ObjectStorageRouteDependencies = {
  readObject,
  readObjectReadToken,
};

function contentTypeFor(key: string): string {
  if (/\.pdf$/i.test(key)) return 'application/pdf';
  if (/\.png$/i.test(key)) return 'image/png';
  if (/\.jpe?g$/i.test(key)) return 'image/jpeg';
  if (/\.gif$/i.test(key)) return 'image/gif';
  if (/\.webp$/i.test(key)) return 'image/webp';
  if (/\.docx$/i.test(key)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

async function sendStoredObject(
  key: string,
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ObjectStorageRouteDependencies,
  headers: { cacheControl: string; contentType: string },
) {
  try {
    const body = await dependencies.readObject(key);
    if (!body) return reply.status(404).send({ error: 'Object not found' });
    return reply
      .header('Content-Type', headers.contentType)
      .header('Cache-Control', headers.cacheControl)
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  } catch (error) {
    request.log.error(error, 'object storage read failed');
    return reply.status(502).send({ error: 'Could not read object storage' });
  }
}

export function registerObjectStorageRoutes(
  fastify: FastifyInstance,
  dependencies: ObjectStorageRouteDependencies = defaultDependencies,
) {
  fastify.get('/storage/logo/:provider/:tenant/:file', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = publicLogoObjectKey(request.params as { provider?: string; tenant?: string; file?: string });
    if (!key) return reply.status(404).send({ error: 'Object not found' });
    const contentType = publicLogoContentType(key);
    if (!contentType) return reply.status(404).send({ error: 'Object not found' });
    return sendStoredObject(key, request, reply, dependencies, {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });

  fastify.get('/storage/object', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { t?: string }).t;
    const key = token ? dependencies.readObjectReadToken(token) : null;
    if (!key) return reply.status(403).send({ error: 'Invalid object link' });
    return sendStoredObject(key, request, reply, dependencies, {
      contentType: contentTypeFor(key),
      cacheControl: 'private, no-store',
    });
  });

  fastify.get('/storage/public/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = (request.params as { '*': string })['*'];
    if (!isPublicObjectKey(key)) return reply.status(404).send({ error: 'Object not found' });
    const contentType = publicLogoContentType(key);
    if (!contentType) return reply.status(404).send({ error: 'Object not found' });
    return sendStoredObject(key, request, reply, dependencies, {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });
}

export async function objectStorageRoutes(fastify: FastifyInstance) {
  registerObjectStorageRoutes(fastify);
}
