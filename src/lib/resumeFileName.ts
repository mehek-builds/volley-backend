function filePart(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function firstLastNamePart(fullName: unknown): string {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return filePart(parts[0]);
  return filePart(`${parts[0]} ${parts[parts.length - 1]}`);
}

export function resumeFileNameForRole(fullName: unknown, role: unknown): string {
  const namePart = firstLastNamePart(fullName) || 'Candidate';
  const rolePart = filePart(role) || 'Role';
  return `${namePart}_${rolePart}_Resume.pdf`;
}

export function contentDispositionFileName(fileName: unknown): string {
  const safe = filePart(String(fileName ?? '').replace(/\.pdf$/i, '')) || 'resume';
  return `${safe}.pdf`;
}
