export type CanonicalApplicationBindingField = 'job_id' | 'company' | 'role' | 'portal_url';

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function normalizedPortal(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalApplicationBindingMismatches(
  stored: {
    jobId: string | null;
    company: string;
    role: string;
    portalUrl: string | null;
  },
  incoming: {
    jobId?: string;
    company: string;
    role: string;
    portalUrl?: string;
  },
): CanonicalApplicationBindingField[] {
  const mismatches: CanonicalApplicationBindingField[] = [];
  if (incoming.jobId !== undefined && stored.jobId !== incoming.jobId) mismatches.push('job_id');
  if (normalizedText(stored.company) !== normalizedText(incoming.company)) mismatches.push('company');
  if (normalizedText(stored.role) !== normalizedText(incoming.role)) mismatches.push('role');
  if (incoming.portalUrl !== undefined) {
    const storedPortal = stored.portalUrl ? normalizedPortal(stored.portalUrl) : null;
    const incomingPortal = normalizedPortal(incoming.portalUrl);
    if (!storedPortal || !incomingPortal || storedPortal !== incomingPortal) mismatches.push('portal_url');
  }
  return mismatches;
}
