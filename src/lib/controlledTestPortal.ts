import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONTROLLED_PORTAL_BINDING_PARAM = 'litos_qa_binding';

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredPublicOrigin(): string | null {
  const raw = process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function bindingSecret(): string | null {
  const value = process.env.LITOS_TEST_PORTAL_BINDING_SECRET?.trim();
  return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

export function controlledPortalBindingInput(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.searchParams.delete(CONTROLLED_PORTAL_BINDING_PARAM);
  url.searchParams.sort();
  return `${url.origin}${url.pathname}${url.search}`;
}

export function controlledPortalBinding(rawUrl: string, secret: string): string {
  return createHmac('sha256', secret).update(controlledPortalBindingInput(rawUrl)).digest('hex');
}

export function isControlledTestPortalUrl(rawUrl: string): boolean {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') return false;
  if (process.env.NODE_ENV === 'production') return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!url.pathname.startsWith('/qa/portal-submission')) return false;

  const host = url.hostname.toLowerCase();
  const builtIn = (url.protocol === 'https:' && (host === 'trylitos.com' || host === 'www.trylitos.com'))
    || (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1'));
  if (builtIn) return true;

  const origin = configuredPublicOrigin();
  const secret = bindingSecret();
  const supplied = url.searchParams.get(CONTROLLED_PORTAL_BINDING_PARAM);
  if (!origin || !secret || url.origin !== origin || !supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return safeEqual(supplied, controlledPortalBinding(rawUrl, secret));
}
