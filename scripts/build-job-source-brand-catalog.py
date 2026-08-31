"""Build the compact ATS-board branding seed used by Litos source verification.

Jobscream (CC0) and Outscal OpenJobs (MIT) are discovery inputs, never job inventory or
verification evidence. Runtime polling still reads every posting from the employer ATS. Domains
from this generated seed remain unverified until the runtime branding verifier confirms both the
company site and a usable image response.

The output is reproducible for fixed upstream snapshots: both inputs use explicit URLs, every
normalization and conflict rule is order-independent, and rows have one deterministic sort order.
"""

from __future__ import annotations

import ipaddress
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urlparse

import fsspec
import pyarrow.parquet as pq

JOBSCREAM_SOURCE_URL = "https://download.jobscream.com/open-jobs.parquet"
OUTSCAL_SOURCE_URL = "https://raw.githubusercontent.com/outscal/OpenJobs/main/data/companies_v2.json"
OUTSCAL_REPOSITORY_URL = "https://github.com/outscal/OpenJobs"
OUTSCAL_LICENSE_URL = "https://github.com/outscal/OpenJobs/blob/main/LICENSE"
OUTSCAL_MAX_BYTES = 8 * 1024 * 1024
OUTPUT = Path(__file__).resolve().parents[1] / "src" / "data" / "jobSourceBrands500k.json"

AUTONOMOUS_ATS = {
    "greenhouse",
    "lever",
    "ashby",
    "workable",
    "rippling",
    "breezy",
    "recruitee",
    "crelate",
}
DNS_LABEL_ATS = {"breezy", "recruitee"}
DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
PATH_SEGMENT = re.compile(r"^[a-z0-9](?:[a-z0-9._~-]{0,126}[a-z0-9])?$")
BARE_DOMAIN = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")

# These hosts can identify an ATS or directory page, but they cannot identify the employer website.
NON_EMPLOYER_DOMAIN_SUFFIXES = {
    "ashbyhq.com",
    "breezy.hr",
    "crelate.com",
    "greenhouse.io",
    "jobs.lever.co",
    "myworkdayjobs.com",
    "outscal.com",
    "recruitee.com",
    "rippling-ats.com",
    "rippling.com",
    "smartrecruiters.com",
    "workable.com",
}

BrandRow = dict[str, str]
BrandKey = tuple[str, str]
BrandClaim = tuple[str, str]


def clean(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.strip().replace("\u2014", "-").split())
    return value or None


def clean_company_name(value: object) -> str | None:
    name = clean(value)
    return name if name and len(name) <= 200 else None


def _valid_bare_domain(domain: str) -> bool:
    if not domain or len(domain) > 253 or not BARE_DOMAIN.fullmatch(domain):
        return False
    labels = domain.split(".")
    if any(len(label) > 63 or label.startswith("-") or label.endswith("-") for label in labels):
        return False
    try:
        ipaddress.ip_address(domain)
        return False
    except ValueError:
        return True


def clean_domain(value: object) -> str | None:
    """Normalize a Jobscream domain field or website into the runtime's bare-domain form."""

    raw = clean(value)
    if not raw:
        return None
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        parsed = urlparse(candidate)
        if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
                or parsed.port is not None):
            return None
    except ValueError:
        return None
    domain = (parsed.hostname or "").lower().strip(".")
    if domain.startswith("www."):
        domain = domain[4:]
    return domain if _valid_bare_domain(domain) else None


def clean_employer_website_domain(value: object) -> str | None:
    """Accept only a usable bare employer domain taken from Outscal's website field."""

    domain = clean_domain(value)
    if not domain:
        return None
    if any(domain == suffix or domain.endswith(f".{suffix}") for suffix in NON_EMPLOYER_DOMAIN_SUFFIXES):
        return None
    return domain


def executable_board_token(ats: str, value: object) -> str | None:
    token = clean(value)
    if not token:
        return None
    try:
        token = unquote(token).strip().lower()
    except (UnicodeDecodeError, ValueError):
        return None
    pattern = DNS_LABEL if ats in DNS_LABEL_ATS else PATH_SEGMENT
    return token if pattern.fullmatch(token) else None


def _parsed_https_url(value: object):
    raw = clean(value)
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port is not None:
            return None
        return parsed
    except ValueError:
        return None


def board_token(ats: str, company: object, url: object) -> str | None:
    """Preserve Jobscream's canonical tenant, preferring its exact first-party ATS URL."""

    parsed = _parsed_https_url(url)
    if not parsed:
        return executable_board_token(ats, company)
    host = (parsed.hostname or "").lower()
    parts = [part for part in parsed.path.split("/") if part]
    token: str | None = None
    if ats == "greenhouse" and host in {"boards.greenhouse.io", "job-boards.greenhouse.io"} and parts:
        token = parts[0] if parts[0].lower() != "embed" else None
    elif ats == "lever" and host in {"jobs.lever.co", "jobs.eu.lever.co"} and parts:
        token = parts[0]
    elif ats == "ashby" and host == "jobs.ashbyhq.com" and parts:
        token = parts[0]
    elif ats == "workable" and host == "apply.workable.com" and parts and parts[0].lower() != "j":
        token = parts[0]
    elif ats == "rippling" and host == "ats.rippling.com" and len(parts) >= 2 and parts[1].lower() == "jobs":
        token = parts[0]
    elif ats == "breezy" and host.endswith(".breezy.hr"):
        token = host.removesuffix(".breezy.hr")
    elif ats == "recruitee" and host.endswith(".recruitee.com"):
        token = host.removesuffix(".recruitee.com")
    elif ats == "crelate" and host == "jobs.crelate.com" and len(parts) >= 2 and parts[0].lower() == "portal":
        token = parts[1]
    return executable_board_token(ats, token) or executable_board_token(ats, company)


def outscal_board_identity(url: object) -> BrandKey | None:
    """Parse only the exact board roots that a current autonomous poller can execute."""

    parsed = _parsed_https_url(url)
    if not parsed or parsed.query or parsed.fragment or parsed.params:
        return None
    host = (parsed.hostname or "").lower()
    parts = [part for part in parsed.path.split("/") if part]
    ats: str | None = None
    token: str | None = None
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"} and len(parts) == 1:
        ats, token = "greenhouse", parts[0]
    elif host == "jobs.lever.co" and len(parts) == 1:
        ats, token = "lever", parts[0]
    elif host == "jobs.ashbyhq.com" and len(parts) == 1:
        ats, token = "ashby", parts[0]
    elif host == "apply.workable.com" and len(parts) == 1:
        ats, token = "workable", parts[0]
    elif host == "ats.rippling.com" and len(parts) == 2 and parts[1].lower() == "jobs":
        ats, token = "rippling", parts[0]
    elif host.endswith(".breezy.hr") and not parts:
        ats, token = "breezy", host.removesuffix(".breezy.hr")
    elif host.endswith(".recruitee.com") and not parts:
        ats, token = "recruitee", host.removesuffix(".recruitee.com")
    elif host == "jobs.crelate.com" and len(parts) == 2 and parts[0].lower() == "portal":
        ats, token = "crelate", parts[1]
    if not ats or ats not in AUTONOMOUS_ATS:
        return None
    normalized = executable_board_token(ats, token)
    return (ats, normalized) if normalized else None


def brand_row(key: BrandKey, claim: BrandClaim) -> BrandRow:
    ats, token = key
    name, domain = claim
    return {
        "ats_name": ats,
        "board_token": token,
        "company_name": name,
        "company_domain": domain,
    }


def jobscream_claims() -> Iterable[tuple[BrandKey, BrandClaim]]:
    columns = ["ats", "company", "company_name", "domain", "website", "url"]
    with fsspec.open(
        JOBSCREAM_SOURCE_URL,
        "rb",
        block_size=8 * 1024 * 1024,
        cache_type="blockcache",
    ) as handle:
        parquet = pq.ParquetFile(handle)
        for batch in parquet.iter_batches(columns=columns, batch_size=50_000):
            values = [batch.column(index).to_pylist() for index in range(len(columns))]
            for ats_raw, company, company_name, domain, website, url in zip(*values):
                ats = (clean(ats_raw) or "").lower()
                if ats not in AUTONOMOUS_ATS:
                    continue
                token = board_token(ats, company, url)
                resolved_domain = clean_domain(domain) or clean_domain(website)
                resolved_name = clean_company_name(company_name)
                if token and resolved_domain and resolved_name:
                    yield (ats, token), (resolved_name, resolved_domain)


def outscal_claims() -> Iterable[tuple[BrandKey, BrandClaim]]:
    with fsspec.open(OUTSCAL_SOURCE_URL, "rb") as handle:
        raw = handle.read(OUTSCAL_MAX_BYTES + 1)
    if len(raw) > OUTSCAL_MAX_BYTES:
        raise ValueError("Outscal company catalog exceeds the byte limit")
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Outscal company catalog must be a JSON array")
    for company in payload:
        if not isinstance(company, dict):
            raise ValueError("Outscal company catalog rows must be objects")
        links = company.get("ats_links")
        if not isinstance(links, list):
            raise ValueError("Outscal company catalog ats_links must be arrays")
        name = clean_company_name(company.get("name"))
        domain = clean_employer_website_domain(company.get("website"))
        if not name or not domain:
            continue
        for link in links:
            key = outscal_board_identity(link)
            if key:
                yield key, (name, domain)


def collapse_claims(
    claims: Iterable[tuple[BrandKey, BrandClaim]],
) -> tuple[dict[BrandKey, BrandClaim], set[BrandKey]]:
    grouped: dict[BrandKey, set[BrandClaim]] = defaultdict(set)
    for key, claim in claims:
        grouped[key].add(claim)
    conflicts = {key for key, values in grouped.items() if len(values) != 1}
    accepted = {key: next(iter(values)) for key, values in grouped.items() if len(values) == 1}
    return accepted, conflicts


def main() -> None:
    jobscream, jobscream_conflicts = collapse_claims(jobscream_claims())
    outscal, outscal_conflicts = collapse_claims(outscal_claims())
    combined, combined_conflicts = collapse_claims([
        *jobscream.items(),
        *outscal.items(),
    ])
    internally_conflicted = jobscream_conflicts | outscal_conflicts
    for key in internally_conflicted:
        combined.pop(key, None)
    combined_conflicts |= internally_conflicted

    rows = [brand_row(key, claim) for key, claim in sorted(combined.items())]
    OUTPUT.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    added = Counter(ats for ats, _token in combined.keys() - jobscream.keys())
    removed = Counter(ats for ats, _token in jobscream.keys() - combined.keys())
    print(json.dumps({
        "output": str(OUTPUT),
        "boards": len(rows),
        "jobscream_boards": len(jobscream),
        "outscal_boards": len(outscal),
        "added_by_family": {ats: added[ats] for ats in sorted(AUTONOMOUS_ATS)},
        "omitted_cross_source_conflicts_by_family": {ats: removed[ats] for ats in sorted(AUTONOMOUS_ATS)},
        "omitted_internal_conflicts": {
            "jobscream": len(jobscream_conflicts),
            "outscal": len(outscal_conflicts),
            "combined": len(combined_conflicts),
        },
        "outscal": {
            "source": OUTSCAL_SOURCE_URL,
            "repository": OUTSCAL_REPOSITORY_URL,
            "license": "MIT",
            "license_url": OUTSCAL_LICENSE_URL,
        },
    }, sort_keys=True))


if __name__ == "__main__":
    main()
