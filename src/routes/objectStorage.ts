import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isPublicObjectKey, readObject, readObjectReadToken } from '../lib/objectStorage';

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
  cacheControl: string,
) {
  try {
    const body = await readObject(key);
    if (!body) return reply.status(404).send({ error: 'Object not found' });
    return reply
      .header('Content-Type', contentTypeFor(key))
      .header('Cache-Control', cacheControl)
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  } catch (error) {
    request.log.error(error, 'object storage read failed');
    return reply.status(502).send({ error: 'Could not read object storage' });
  }
}

export async function objectStorageRoutes(fastify: FastifyInstance) {
  fastify.get('/storage/object', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { t?: string }).t;
    const key = token ? readObjectReadToken(token) : null;
    if (!key) return reply.status(403).send({ error: 'Invalid object link' });
    return sendStoredObject(key, request, reply, 'private, no-store');
  });

  fastify.get('/storage/public/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = (request.params as { '*': string })['*'];
    if (!isPublicObjectKey(key)) return reply.status(404).send({ error: 'Object not found' });
    return sendStoredObject(
      key,
      request,
      reply,
      'public, max-age=31536000, immutable',
    );
  });
}
