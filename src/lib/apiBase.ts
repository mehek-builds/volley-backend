import type { FastifyRequest } from 'fastify';

// Absolute base URL for links this API hands back to clients (resume download links). Vercel
// terminates TLS at the edge, so request.protocol reads `http` inside the function and
// x-forwarded-proto is the only honest scheme. PUBLIC_API_BASE overrides both if the API ever
// serves a different hostname than the one the request arrived on.
export function apiBaseFor(request: FastifyRequest): string {
  const configured = process.env.PUBLIC_API_BASE;
  if (configured) return configured.replace(/\/+$/, '');
  const forwardedProto = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const forwardedHost = (request.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  return `${forwardedProto || request.protocol}://${forwardedHost || request.headers.host}`;
}
