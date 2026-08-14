export type ClientVersionHeaders = Record<string, string | string[] | undefined>;

export function isLegacyExtensionVersion(headers: ClientVersionHeaders): boolean {
  if (headers['x-litos-client'] !== 'extension') return false;
  const version = headers['x-litos-version'];
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 0 && minor < 6;
}
