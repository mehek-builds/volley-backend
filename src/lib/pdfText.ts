import pdfParse from 'pdf-parse';

// The ONE place PDF text extraction happens, and the one place its footgun is documented.
//
// R-017 root cause (isolated 2026-07-17): pdf-parse@1.1.1's bundled pdf.js (v1.10.100) has a
// byteOffset aliasing bug. Its Stream.makeSubStream builds substreams from `bytes.buffer`, the
// RAW underlying ArrayBuffer, without honoring the view's byteOffset. Node allocates Buffers
// smaller than ~4KB inside a shared 8KB pool at a nonzero byteOffset (Buffer.concat and small
// readFileSync results both land there), so every xref-entry fetch reads bytes shifted by that
// offset and throws FormatError: "bad XRef entry". A rendered resume is ~2.5KB, which is why the
// post-render check threw on EVERY render while the same PDFs parsed perfectly in pdftotext and
// pypdf: the file was always fine, the parser was reading the wrong slab of memory. It is also
// why the bug looked content-dependent in isolation: a fresh process's first pooled allocation
// sits at byteOffset 0 and parses, later ones do not.
//
// Copying into a fresh Uint8Array pins byteOffset to 0, the only layout the old parser handles.
// The copy costs a few KB per call and buys back the whole safety net; swapping the library out
// remains open as a follow-up, but this fixes the check without a new dependency.
export async function extractPdfText(pdf: Buffer | Uint8Array): Promise<{ text: string; numpages: number }> {
  const zeroOffset = new Uint8Array(pdf); // copies into a fresh ArrayBuffer, byteOffset 0
  const parsed = await pdfParse(zeroOffset as unknown as Buffer);
  return { text: parsed.text, numpages: parsed.numpages };
}
