#!/usr/bin/env python3
"""Certified H-1B labor condition applications, counted per employer.

Called by scripts/build-h1b-sponsors.mjs, which cannot read these files itself: DOL publishes one
~100MB .xlsx per quarter and the backend has no spreadsheet dependency. Python's openpyxl streams
them in read-only mode, so the whole fiscal year costs a few hundred MB of I/O and no memory to
speak of.

Prints one JSON object to stdout: {"<employer name>": <certified count>}. Progress goes to stderr.

WHAT A CERTIFIED LCA IS, and why it counts as evidence: before filing an H-1B petition an employer
must file a Labor Condition Application naming the role, the worksite and the wage, and attest to
paying it. DOL certifying it is that attestation on the record. It is not an approved petition -
that is what the USCIS data holds - so the two are counted separately and the generated file says
which one confirmed each employer.
"""
import json
import re
import sys
from collections import defaultdict

try:
    import openpyxl
except ImportError:
    print("openpyxl is required: pip3 install openpyxl", file=sys.stderr)
    sys.exit(2)

# H-1B1 is the Chile/Singapore variant of the same programme. Excluded: E-3 (Australia only) and
# H-1B's cap-exempt cousins, which say nothing about whether the employer sponsors an H-1B.
VISA_CLASSES = {"H-1B", "H-1B1 CHILE", "H-1B1 SINGAPORE"}

employers = defaultdict(int)
for path in sys.argv[1:]:
    book = openpyxl.load_workbook(path, read_only=True)
    try:
        sheet = book[book.sheetnames[0]]
        rows = sheet.iter_rows(values_only=True)
        header = next(rows)
        try:
            i_status = header.index("CASE_STATUS")
            i_visa = header.index("VISA_CLASS")
            i_employer = header.index("EMPLOYER_NAME")
        except ValueError:
            print(f"{path}: unexpected columns, DOL changed the schema", file=sys.stderr)
            sys.exit(1)
        widest = max(i_status, i_visa, i_employer)
        scanned = 0
        kept = 0
        for row in rows:
            scanned += 1
            # A ragged trailing row yields a short tuple, and an IndexError two hours into a 400MB
            # parse costs the whole run.
            if len(row) <= widest:
                continue
            name = row[i_employer]
            if not name:
                continue
            if str(row[i_visa]).strip().upper() not in VISA_CLASSES:
                continue
            # DOL's status domain is Certified, Certified - Withdrawn, Denied, Withdrawn. Only the
            # first is counted: a certification later withdrawn is frequently one where the petition
            # was never filed, and six employers here are confirmed on a SINGLE certification, so
            # the difference decides whether they appear on somebody's board at all.
            if str(row[i_status]).strip().upper() != "CERTIFIED":
                continue
            employers[re.sub(r"\s+", " ", str(name)).strip()] += 1
            kept += 1
        print(f"{path}: {scanned} rows, {kept} certified H-1B", file=sys.stderr)
    finally:
        book.close()

json.dump(employers, sys.stdout)
