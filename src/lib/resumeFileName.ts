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

export function coverLetterFileNameForRole(fullName: unknown, role: unknown): string {
  const namePart = firstLastNamePart(fullName) || 'Candidate';
  const rolePart = filePart(role) || 'Role';
  return `${namePart}_${rolePart}_Cover_Letter.pdf`;
}

/* The same naming as the two files Litos makes, for a file Litos did not make.
 *
 * Her own upload's name is deliberately not reused. It is whatever her registrar or her laptop
 * called it, it reaches a recruiter's inbox beside two files named Firstname_Lastname_Role_*, and it
 * is the one string in this packet that Litos has never normalized: it can carry her student id, a
 * download counter, or somebody else's name from a shared folder. Renaming it costs nothing, because
 * nothing downstream reads the name - the bytes are handed to the form exactly as she gave them.
 */
export function transcriptFileNameForRole(fullName: unknown, role: unknown): string {
  const namePart = firstLastNamePart(fullName) || 'Candidate';
  const rolePart = filePart(role) || 'Role';
  return `${namePart}_${rolePart}_Transcript.pdf`;
}

export function contentDispositionFileName(fileName: unknown): string {
  const safe = filePart(String(fileName ?? '').replace(/\.pdf$/i, '')) || 'resume';
  return `${safe}.pdf`;
}
