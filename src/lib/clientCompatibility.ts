import { CLIENT_COMPATIBILITY } from './product';

export type ClientVersionHeaders = Record<string, string | string[] | undefined>;

function semanticVersion(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function extensionClientNeedsSafetyUpdate(
  headers: ClientVersionHeaders,
  origin?: string,
): boolean {
  const extensionContext = headers['x-litos-client'] === 'extension'
    || Boolean(origin?.startsWith('chrome-extension://'));
  if (!extensionContext) return false;
  const current = semanticVersion(headers['x-litos-version']);
  const minimum = semanticVersion(CLIENT_COMPATIBILITY.extension.minimum)!;
  if (!current) return true;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index]! > minimum[index]!) return false;
    if (current[index]! < minimum[index]!) return true;
  }
  return false;
}

export function extensionSafetyUpdatePathIsEvidenceOnly(method: string, rawUrl: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'OPTIONS') return true;
  const path = rawUrl.split('?')[0] ?? rawUrl;
  return (normalizedMethod === 'POST' && path === '/autofill/event')
    || path === '/v1/meta'
    || path === '/health'
    || path === '/track'
    || /\/manual-submission-(?:outcome|resolution)$/.test(path)
    || /\/submission\/(?:extension-outcome|unverified|self-submitted)$/.test(path);
}

export function isLegacyExtensionVersion(headers: ClientVersionHeaders): boolean {
  if (headers['x-litos-client'] !== 'extension') return false;
  const version = headers['x-litos-version'];
  if (typeof version !== 'string') return false;
  const parsed = semanticVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major === 0 && minor < 6;
}
