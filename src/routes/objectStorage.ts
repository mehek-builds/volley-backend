import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  publicLogoContentType,
  publicLogoObjectKey,
  readObject,
  readObjectReadToken,
} from '../lib/objectStorage';

function contentTypeFor(key: string): string {
  if (/\.pdf$/i.test(key)) return 'application/pdf';
  if (/\.png$/i.test(key)) return 'image/png';
  if (/\.jpe?g$/i.test(key)) return 'image/jpeg';
  if (/\.gif$/i.test(key)) return 'image/gif';
  if (/\.webp$/i.test(key)) return 'image/webp';
  if (/\.docx$/i.test(key)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

export type ObjectStorageRouteDependencies = {
  readStoredObject?: typeof readObject;
};

export async function objectStorageRoutes(
  fastify: FastifyInstance,
  dependencies: ObjectStorageRouteDependencies = {},
) {
  const readStoredObject = dependencies.readStoredObject ?? readObject;
  fastify.get('/storage/logo/:provider/:tenant/:file', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = publicLogoObjectKey(request.params as { provider?: string; tenant?: string; file?: string });
    if (!key) return reply.status(404).send({ error: 'Object not found' });
    try {
      const body = await readStoredObject(key);
      if (!body) return reply.status(404).send({ error: 'Object not found' });
      return reply
        .header('Content-Type', publicLogoContentType(key) ?? contentTypeFor(key))
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .send(body);
    } catch (error) {
      request.log.error(error, 'public logo storage read failed');
      return reply.status(502).send({ error: 'Could not read object storage' });
    }
  });

  fastify.get('/storage/object', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { t?: string }).t;
    const key = token ? readObjectReadToken(token) : null;
    if (!key) return reply.status(403).send({ error: 'Invalid object link' });
    try {
      const body = await readStoredObject(key);
      if (!body) return reply.status(404).send({ error: 'Object not found' });
      return reply
        .header('Content-Type', contentTypeFor(key))
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(body);
    } catch (error) {
      request.log.error(error, 'object storage read failed');
      return reply.status(502).send({ error: 'Could not read object storage' });
    }
  });
}
