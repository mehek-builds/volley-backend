/* GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Written by scripts/build-h1b-sponsors.mjs from two government sources: approved H-1B petitions
 * (USCIS Employer Data Hub) and certified H-1B labor condition applications (DOL). Every employer
 * Litos watches is listed, including the ones with no filings: an absent company would be
 * ambiguous between "never checked" and "checked, nothing found", and those need opposite
 * responses. `npm run sponsors:check` fails when this file no longer matches the source data or
 * the board.
 */
import type { H1bSponsorFile } from '../lib/sponsorEmployers';

export const H1B_SPONSOR_FILE: H1bSponsorFile = {
  "source": "USCIS H-1B Employer Data Hub",
  "source_urls": [
    "https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2021.csv",
    "https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2022.csv",
    "https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2023.csv"
  ],
  "fiscal_years": [
    2021,
    2022,
    2023
  ],
  "lca_source": "DOL H-1B Labor Condition Applications",
  "lca_source_urls": [
    "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q1.xlsx",
    "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q2.xlsx",
    "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q3.xlsx",
    "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q4.xlsx"
  ],
  "lca_quarters": [
    "FY2025_Q1",
    "FY2025_Q2",
    "FY2025_Q3",
    "FY2025_Q4"
  ],
  "employers": [
    {
      "company": "Abnormal AI",
      "normalized": "ABNORMAL AI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ABNORMAL SECURITY",
      "legal_names": [
        "ABNORMAL SECURITY CORP",
        "ABNORMAL SECURITY CORPORATION",
        "Abnormal AI, Inc.",
        "Abnormal Security Corporation"
      ],
      "approvals": 56,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 32,
      "filing_states": [
        "CA",
        "NV"
      ],
      "filing_cities": [
        "LAS VEGAS",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Abridge",
      "normalized": "ABRIDGE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ABRIDGE AI",
      "legal_names": [
        "ABRIDGE AI INC",
        "Abridge AI, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 9,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "PHILADELPHIA",
        "PITTSBURGH"
      ]
    },
    {
      "company": "Access Bank PLC",
      "normalized": "ACCESS BANK",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "AD Education",
      "normalized": "AD EDUCATION",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Adyen",
      "normalized": "ADYEN",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ADYEN",
      "legal_names": [
        "ADYEN INC"
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Aerones",
      "normalized": "AERONES",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Affirm",
      "normalized": "AFFIRM",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AFFIRM",
      "legal_names": [
        "AFFIRM INC",
        "Affirm, Inc."
      ],
      "approvals": 237,
      "denials": 7,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 103,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "AI Acquisition",
      "normalized": "AI ACQUISITION",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Airbnb",
      "normalized": "AIRBNB",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AIRBNB",
      "legal_names": [
        "AIRBNB INC",
        "AIRBNB, INC."
      ],
      "approvals": 557,
      "denials": 5,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 222,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Airtable",
      "normalized": "AIRTABLE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "FORMAGRID INC D B A AIRTABLE",
      "legal_names": [
        "FORMAGRID INC D/B/A AIRTABLE",
        "FORMAGRID INC DBA AIRTABLE"
      ],
      "approvals": 78,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Airwallex",
      "normalized": "AIRWALLEX",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Akuna",
      "normalized": "AKUNA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AKUNA CAPITAL",
      "legal_names": [
        "AKUNA CAPITAL LLC",
        "Akuna Capital, LLC"
      ],
      "approvals": 84,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 37,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "Alloy",
      "normalized": "ALLOY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "FIRST MILE GROUP INC DBA ALLOY",
      "legal_names": [
        "FIRST MILE GROUP INC DBA ALLOY"
      ],
      "approvals": 16,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Amplitude",
      "normalized": "AMPLITUDE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AMPLITUDE",
      "legal_names": [
        "AMPLITUDE INC",
        "Amplitude, Inc."
      ],
      "approvals": 39,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 26,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "amwell",
      "normalized": "AMWELL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Anduril Industries",
      "normalized": "ANDURIL INDUSTRIES",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ANDURIL INDUSTRIES",
      "legal_names": [
        "ANDURIL INDUSTRIES INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "IRVINE"
      ]
    },
    {
      "company": "anomalo",
      "normalized": "ANOMALO",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "ANOMALO",
      "legal_names": [
        "Anomalo, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO"
      ]
    },
    {
      "company": "Anthropic",
      "normalized": "ANTHROPIC",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ANTHROPIC",
      "legal_names": [
        "ANTHROPIC PBC",
        "ANTHROPIC PBC D B A ANTHROPIC INC",
        "ANTHROPIC PBC D/B/A ANTHROPIC INC",
        "ANTHROPIC PBC DBA ANTHROPIC INC",
        "Anthropic, PBC"
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 107,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "anydesk",
      "normalized": "ANYDESK",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Anyscale",
      "normalized": "ANYSCALE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ANYSCALE",
      "legal_names": [
        "ANYSCALE INC",
        "Anyscale, Inc."
      ],
      "approvals": 19,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 19,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "BERKELEY",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "aptoslabs",
      "normalized": "APTOSLABS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MATONEE INC D B A APTOS LABS",
      "legal_names": [
        "MATONEE INC D/B/A APTOS LABS"
      ],
      "approvals": 16,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW",
        "PALO ALTO"
      ]
    },
    {
      "company": "AQR",
      "normalized": "AQR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AQR CAPITAL MANAGEMENT",
      "legal_names": [
        "AQR CAPITAL MANAGEMENT LLC",
        "AQR Capital Management, LLC"
      ],
      "approvals": 108,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 36,
      "filing_states": [
        "CT"
      ],
      "filing_cities": [
        "GREENWICH"
      ]
    },
    {
      "company": "Asana",
      "normalized": "ASANA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ASANA",
      "legal_names": [
        "ASANA INC",
        "Asana, Inc."
      ],
      "approvals": 158,
      "denials": 7,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 43,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Ashby",
      "normalized": "ASHBY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Assembled",
      "normalized": "ASSEMBLED",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ASSEMBLED",
      "legal_names": [
        "ASSEMBLED INC",
        "Assembled, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 3,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PLEASANTON",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Astranis",
      "normalized": "ASTRANIS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "astronomer",
      "normalized": "ASTRONOMER",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ASTRONOMER",
      "legal_names": [
        "ASTRONOMER INC",
        "Astronomer, Inc."
      ],
      "approvals": 14,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 3,
      "filing_states": [
        "NY",
        "OH"
      ],
      "filing_cities": [
        "CINCINNATI",
        "NEW YORK"
      ]
    },
    {
      "company": "atlan",
      "normalized": "ATLAN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ATLAN",
      "legal_names": [
        "ATLAN INC",
        "Atlan Inc",
        "MAHANTKESHAVJIVANDAS LLC DBA ATLAN"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 6,
      "filing_states": [
        "DE",
        "GA"
      ],
      "filing_cities": [
        "LILBURN",
        "WILMINGTON"
      ]
    },
    {
      "company": "attio",
      "normalized": "ATTIO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Axios",
      "normalized": "AXIOS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Base.com",
      "normalized": "BASE COM",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Baseten",
      "normalized": "BASETEN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BASETEN LABS",
      "legal_names": [
        "BASETEN LABS INC",
        "Baseten Labs, Inc"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 8,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "betterhelp",
      "normalized": "BETTERHELP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Betterment",
      "normalized": "BETTERMENT",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "BETTERMENT HOLDINGS",
      "legal_names": [
        "BETTERMENT HOLDINGS INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "binalyze",
      "normalized": "BINALYZE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "bishopfox",
      "normalized": "BISHOPFOX",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "STACH AND LIU LLC DBA BISHOP FOX",
      "legal_names": [
        "STACH & LIU LLC DBA BISHOP FOX"
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "AZ"
      ],
      "filing_cities": [
        "TEMPE"
      ]
    },
    {
      "company": "bitgo",
      "normalized": "BITGO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BITGO",
      "legal_names": [
        "BITGO INC",
        "BitGo, Inc."
      ],
      "approvals": 18,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 20,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO"
      ]
    },
    {
      "company": "Bitpanda",
      "normalized": "BITPANDA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Blacksmith",
      "normalized": "BLACKSMITH",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Blend",
      "normalized": "BLEND",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BLEND LABS",
      "legal_names": [
        "BLEND LABS INC",
        "BLEND LABS INC."
      ],
      "approvals": 92,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 6,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "NOVATO",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Blink - The Employee App",
      "normalized": "BLINK THE EMPLOYEE APP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Block",
      "normalized": "BLOCK",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BLOCK",
      "legal_names": [
        "BLOCK INC",
        "Block, Inc."
      ],
      "approvals": 433,
      "denials": 5,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 258,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "OAKLAND",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "blueconic",
      "normalized": "BLUECONIC",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Box",
      "normalized": "BOX",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BOX",
      "legal_names": [
        "BOX INC",
        "Box, Inc."
      ],
      "approvals": 190,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 95,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "Braintrust",
      "normalized": "BRAINTRUST",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "BRAINTRUST DATA",
      "legal_names": [
        "Braintrust Data, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 3,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Braze",
      "normalized": "BRAZE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BRAZE",
      "legal_names": [
        "BRAZE INC",
        "Braze, Inc."
      ],
      "approvals": 26,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Brex",
      "normalized": "BREX",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BREX",
      "legal_names": [
        "BREX INC",
        "Brex Inc."
      ],
      "approvals": 112,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 28,
      "filing_states": [
        "CA",
        "UT",
        "WA"
      ],
      "filing_cities": [
        "BOTHELL",
        "DRAPER",
        "SALT LAKE CITY",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "btgpactual",
      "normalized": "BTGPACTUAL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BTG PACTUAL US CAPITAL",
      "legal_names": [
        "BTG PACTUAL US CAPITAL LLC",
        "BTG Pactual US Capital LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 5,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "buildkite",
      "normalized": "BUILDKITE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "C-Serv",
      "normalized": "C SERV",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Calendly",
      "normalized": "CALENDLY",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "CALENDLY",
      "legal_names": [
        "Calendly, LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "calm",
      "normalized": "CALM",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CALM",
      "legal_names": [
        "CALM INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Capgemini",
      "normalized": "CAPGEMINI",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Carta",
      "normalized": "CARTA",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ESHARES INC D B A CARTA",
      "legal_names": [
        "ESHARES INC D/B/A CARTA",
        "ESHARES INC DBA CARTA",
        "ESHARES INC DBA CARTA INC"
      ],
      "approvals": 174,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO",
        "SAN CARLOS",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "causaly",
      "normalized": "CAUSALY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Cerebras",
      "normalized": "CEREBRAS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CEREBRAS SYSTEMS",
      "legal_names": [
        "CEREBRAS SYSTEMS INC",
        "CEREBRAS SYSTEMS INC."
      ],
      "approvals": 52,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 31,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "LOS ALTOS",
        "SUNNYVALE"
      ]
    },
    {
      "company": "Chainguard",
      "normalized": "CHAINGUARD",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CHAINGUARD",
      "legal_names": [
        "CHAINGUARD INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "WA"
      ],
      "filing_cities": [
        "KIRKLAND"
      ]
    },
    {
      "company": "Chan Zuckerberg Initiative",
      "normalized": "CHAN ZUCKERBERG INITIATIVE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CHAN ZUCKERBERG INITIATIVE",
      "legal_names": [
        "CHAN ZUCKERBERG INITIATIVE LLC",
        "CHAN ZUCKERBERG INITIATIVE, LLC"
      ],
      "approvals": 14,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "checkly",
      "normalized": "CHECKLY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Checkr",
      "normalized": "CHECKR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CHECKR",
      "legal_names": [
        "CHECKR INC",
        "Checkr, Inc."
      ],
      "approvals": 36,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Chime",
      "normalized": "CHIME",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CHIME FINANCIAL",
      "legal_names": [
        "CHIME FINANCIAL INC",
        "Chime Financial, Inc."
      ],
      "approvals": 181,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 130,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "circleci",
      "normalized": "CIRCLECI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CIRCLE INTERNET SERVICES",
      "legal_names": [
        "CIRCLE INTERNET SERVICES INC",
        "CIRCLE INTERNET SERVICES, INC."
      ],
      "approvals": 12,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "cleo",
      "normalized": "CLEO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CLEO AI",
      "legal_names": [
        "CLEO AI INC",
        "Cleo AI Inc."
      ],
      "approvals": 3,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "DE",
        "NY"
      ],
      "filing_cities": [
        "NEW YORK",
        "WILMINGTON"
      ]
    },
    {
      "company": "Clickhouse",
      "normalized": "CLICKHOUSE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CLICKHOUSE",
      "legal_names": [
        "CLICKHOUSE INC",
        "ClickHouse, Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 9,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PORTOLA VALLEY"
      ]
    },
    {
      "company": "Cloudflare",
      "normalized": "CLOUDFLARE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CLOUDFLARE",
      "legal_names": [
        "CLOUDFLARE INC",
        "CLOUDFLARE, INC."
      ],
      "approvals": 172,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 98,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Clover Health",
      "normalized": "CLOVER HEALTH",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "CLOVER HEALTH",
      "legal_names": [
        "CLOVER HEALTH, LLC."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "JERSEY CITY"
      ]
    },
    {
      "company": "cockroachlabs",
      "normalized": "COCKROACHLABS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "COCKROACH LABS",
      "legal_names": [
        "COCKROACH LABS INC",
        "Cockroach Labs, Inc."
      ],
      "approvals": 15,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 4,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "codat",
      "normalized": "CODAT",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CODAT",
      "legal_names": [
        "CODAT INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Code for America",
      "normalized": "CODE FOR AMERICA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Coder",
      "normalized": "CODER",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Cohere",
      "normalized": "COHERE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Coinbase",
      "normalized": "COINBASE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "COINBASE",
      "legal_names": [
        "COINBASE INC",
        "Coinbase, Inc."
      ],
      "approvals": 430,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 180,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "OAKLAND",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Column",
      "normalized": "COLUMN",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Common App",
      "normalized": "COMMON APP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "consensys",
      "normalized": "CONSENSYS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CONSENSYS",
      "legal_names": [
        "CONSENSYS INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "DC"
      ],
      "filing_cities": [
        "WASHINGTON"
      ]
    },
    {
      "company": "Create Wellness, Inc.",
      "normalized": "CREATE WELLNESS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "cresta",
      "normalized": "CRESTA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CRESTA INTELLIGENCE",
      "legal_names": [
        "CRESTA INTELLIGENCE INC",
        "Cresta Intelligence Inc."
      ],
      "approvals": 13,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 9,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO",
        "SAN FRANCISCO",
        "SUNNYVALE"
      ]
    },
    {
      "company": "crisp",
      "normalized": "CRISP",
      "sponsors": false,
      "evidence": null,
      "rejected": "the ashby token `crisp` is the Dutch grocer, which really is called Crisp - the board is correctly labelled. A US \"Crisp, Inc.\" files H-1B petitions and normalises to the same key, so this is a rejection of the FILING match, not of the source",
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Crunchyroll",
      "normalized": "CRUNCHYROLL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CRUNCHYROLL",
      "legal_names": [
        "CRUNCHYROLL LLC",
        "Crunchyroll, LLC"
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 22,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "COPPELL"
      ]
    },
    {
      "company": "Crusoe",
      "normalized": "CRUSOE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "cultureamp",
      "normalized": "CULTUREAMP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "curative",
      "normalized": "CURATIVE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CURATIVE",
      "legal_names": [
        "CURATIVE INC"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN DIMAS"
      ]
    },
    {
      "company": "Cursor",
      "normalized": "CURSOR",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "ANYSPHERE",
      "legal_names": [
        "Anysphere, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 6,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "D-ploy",
      "normalized": "D PLOY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Databricks",
      "normalized": "DATABRICKS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DATABRICKS",
      "legal_names": [
        "DATABRICKS INC",
        "Databricks, Inc."
      ],
      "approvals": 459,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 378,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Datadog",
      "normalized": "DATADOG",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DATADOG",
      "legal_names": [
        "DATADOG INC",
        "Datadog, Inc."
      ],
      "approvals": 89,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 125,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "datafold",
      "normalized": "DATAFOLD",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "dataiku",
      "normalized": "DATAIKU",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DATAIKU",
      "legal_names": [
        "DATAIKU INC",
        "Dataiku Inc.",
        "Dataiku, Inc."
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 8,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "decagon",
      "normalized": "DECAGON",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "DECAGON AI",
      "legal_names": [
        "Decagon AI, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 8,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Deepgram",
      "normalized": "DEEPGRAM",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "DEEPGRAM",
      "legal_names": [
        "DEEPGRAM INC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Depot",
      "normalized": "DEPOT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Digital",
      "normalized": "DIGITAL",
      "sponsors": false,
      "evidence": null,
      "rejected": "the Workable account is a distributed digital agency. The filings belong to Asian Media Rights and CPX Interactive, two unrelated companies that used Digital as a d/b/a",
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Discord",
      "normalized": "DISCORD",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DISCORD",
      "legal_names": [
        "DISCORD INC",
        "Discord, Inc."
      ],
      "approvals": 48,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 26,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Domes Resorts & Reserves",
      "normalized": "DOMES RESORTS AND RESERVES",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "doppel",
      "normalized": "DOPPEL",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "DOPPEL",
      "legal_names": [
        "Doppel Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "COVINA"
      ]
    },
    {
      "company": "Doppler",
      "normalized": "DOPPLER",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Doximity",
      "normalized": "DOXIMITY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DOXIMITY",
      "legal_names": [
        "DOXIMITY INC",
        "Doximity",
        "Doximity, Inc."
      ],
      "approvals": 20,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 8,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "dremio",
      "normalized": "DREMIO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DREMIO",
      "legal_names": [
        "DREMIO CORPORATION",
        "Dremio Corporation"
      ],
      "approvals": 31,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 7,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SANTA CLARA"
      ]
    },
    {
      "company": "Dropbox",
      "normalized": "DROPBOX",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DROPBOX",
      "legal_names": [
        "DROPBOX INC",
        "Dropbox, Inc."
      ],
      "approvals": 387,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 67,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO",
        "SAN JOSE"
      ]
    },
    {
      "company": "DRW",
      "normalized": "DRW",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Duolingo",
      "normalized": "DUOLINGO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DUOLINGO",
      "legal_names": [
        "DUOLINGO INC",
        "Duolingo, Inc."
      ],
      "approvals": 39,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 40,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "PITTSBURGH"
      ]
    },
    {
      "company": "DV Trading",
      "normalized": "DV TRADING",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Elastic",
      "normalized": "ELASTIC",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ELASTICSEARCH",
      "legal_names": [
        "A52 LLC D B A ELASTIC",
        "A52 LLC DBA ELASTIC",
        "ELASTICSEARCH INC",
        "Elasticsearch, Inc."
      ],
      "approvals": 45,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 21,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW",
        "SAN FRANCISCO",
        "SANTA MONICA"
      ]
    },
    {
      "company": "elationhealth",
      "normalized": "ELATIONHEALTH",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ELATION HEALTH",
      "legal_names": [
        "ELATION HEALTH INC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Elevation Capital",
      "normalized": "ELEVATION CAPITAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "ElevenLabs",
      "normalized": "ELEVENLABS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "ELEVEN LABS",
      "legal_names": [
        "Eleven Labs, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "elicit",
      "normalized": "ELICIT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Engineers Gate",
      "normalized": "ENGINEERS GATE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Epic Games",
      "normalized": "EPIC GAMES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "EPIC GAMES",
      "legal_names": [
        "EPIC GAMES INC",
        "Epic Games, Inc."
      ],
      "approvals": 49,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 56,
      "filing_states": [
        "NC",
        "PA"
      ],
      "filing_cities": [
        "CARY",
        "DRUMORE"
      ]
    },
    {
      "company": "Epirus",
      "normalized": "EPIRUS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "EPOS",
      "normalized": "EPOS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Etched",
      "normalized": "ETCHED",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Everlane",
      "normalized": "EVERLANE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "EVERLANE",
      "legal_names": [
        "EVERLANE INC"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "evervault",
      "normalized": "EVERVAULT",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "EVERVAULT",
      "legal_names": [
        "Evervault Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Facet",
      "normalized": "FACET",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Faire",
      "normalized": "FAIRE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FAIRE WHOLESALE",
      "legal_names": [
        "FAIRE WHOLESALE INC",
        "Faire Wholesale, Inc."
      ],
      "approvals": 39,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 18,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "FanDuel",
      "normalized": "FANDUEL",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "FANDUEL",
      "legal_names": [
        "FANDUEL INC"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA",
        "NY"
      ],
      "filing_cities": [
        "LOS ANGELES",
        "NEW YORK"
      ]
    },
    {
      "company": "Fastly",
      "normalized": "FASTLY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FASTLY",
      "legal_names": [
        "FASTLY INC",
        "Fastly, Inc."
      ],
      "approvals": 19,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 9,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Figma",
      "normalized": "FIGMA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FIGMA",
      "legal_names": [
        "FIGMA INC",
        "Figma, Inc."
      ],
      "approvals": 48,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 49,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "figment",
      "normalized": "FIGMENT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Figure",
      "normalized": "FIGURE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Financeit",
      "normalized": "FINANCEIT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "fireblocks",
      "normalized": "FIREBLOCKS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FIREBLOCKS",
      "legal_names": [
        "FIREBLOCKS INC",
        "Fireblocks, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 5,
      "filing_states": [
        "NJ",
        "NY"
      ],
      "filing_cities": [
        "ENGLEWOOD CLIFFS",
        "NEW YORK"
      ]
    },
    {
      "company": "Fireworks",
      "normalized": "FIREWORKS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "FIREWORKS AI",
      "legal_names": [
        "Fireworks.ai, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 11,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "Five Rings",
      "normalized": "FIVE RINGS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FIVE RINGS",
      "legal_names": [
        "FIVE RINGS LLC",
        "Five Rings LLC"
      ],
      "approvals": 11,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 8,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Fivetran",
      "normalized": "FIVETRAN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FIVETRAN",
      "legal_names": [
        "FIVETRAN INC",
        "Fivetran Inc.",
        "Fivetran, Inc."
      ],
      "approvals": 39,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 11,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "OAKLAND"
      ]
    },
    {
      "company": "Flexport",
      "normalized": "FLEXPORT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FLEXPORT",
      "legal_names": [
        "FLEXPORT INC",
        "Flexport, Inc."
      ],
      "approvals": 168,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 37,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Flow Traders",
      "normalized": "FLOW TRADERS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "FLOW TRADERS US",
      "legal_names": [
        "FLOW TRADERS US LLC"
      ],
      "approvals": 13,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Formlabs",
      "normalized": "FORMLABS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FORMLABS",
      "legal_names": [
        "FORMLABS INC",
        "FORMLABS, INC.",
        "Formlabs, Inc."
      ],
      "approvals": 37,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 18,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "SOMERVILLE"
      ]
    },
    {
      "company": "found",
      "normalized": "FOUND",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Foundation",
      "normalized": "FOUNDATION",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "freenome",
      "normalized": "FREENOME",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FREENOME HOLDINGS",
      "legal_names": [
        "FREENOME HOLDINGS INC",
        "Freenome Holdings, Inc."
      ],
      "approvals": 21,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 7,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "BRISBANE",
        "SOUTH SAN FRANCISCO"
      ]
    },
    {
      "company": "fullstory",
      "normalized": "FULLSTORY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FULLSTORY",
      "legal_names": [
        "FULLSTORY INC",
        "FullStory, Inc."
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 3,
      "filing_states": [
        "GA"
      ],
      "filing_cities": [
        "ATLANTA"
      ]
    },
    {
      "company": "Fuse Energy",
      "normalized": "FUSE ENERGY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "gamma",
      "normalized": "GAMMA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Gemini",
      "normalized": "GEMINI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GEMINI TRUST COMPANY",
      "legal_names": [
        "GEMINI TRUST COMPANY LLC",
        "Gemini Trust Company, LLC"
      ],
      "approvals": 60,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Geotab",
      "normalized": "GEOTAB",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "GEOTAB",
      "legal_names": [
        "GEOTAB INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NV"
      ],
      "filing_cities": [
        "LAS VEGAS"
      ]
    },
    {
      "company": "GetYourGuide",
      "normalized": "GETYOURGUIDE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "GETYOURGUIDE",
      "legal_names": [
        "GetYourGuide, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK CITY"
      ]
    },
    {
      "company": "Ginkgo",
      "normalized": "GINKGO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GINKGO BIOWORKS",
      "legal_names": [
        "GINKGO BIOWORKS INC",
        "Ginkgo Bioworks, Inc."
      ],
      "approvals": 78,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 13,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON"
      ]
    },
    {
      "company": "GitLab",
      "normalized": "GITLAB",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "GiveDirectly",
      "normalized": "GIVEDIRECTLY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GIVEDIRECTLY",
      "legal_names": [
        "GIVEDIRECTLY INC",
        "GiveDirectly, Inc."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "GoGlobal",
      "normalized": "GOGLOBAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Gong",
      "normalized": "GONG",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "gorgias",
      "normalized": "GORGIAS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GORGIAS",
      "legal_names": [
        "GORGIAS INC",
        "Gorgias, Inc."
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 6,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Grafana Labs",
      "normalized": "GRAFANA LABS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "RAINTANK INC DBA GRAFANA LABS",
      "legal_names": [
        "RAINTANK INC DBA GRAFANA LABS"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "graphcore",
      "normalized": "GRAPHCORE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "GRAPHCORE",
      "legal_names": [
        "GRAPHCORE INC"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO"
      ]
    },
    {
      "company": "groww",
      "normalized": "GROWW",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "GSA Capital",
      "normalized": "GSA CAPITAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Gusto",
      "normalized": "GUSTO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GUSTO",
      "legal_names": [
        "GUSTO INC",
        "Gusto, Inc.",
        "ZENPAYROLL INC DBA GUSTO"
      ],
      "approvals": 76,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 49,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Harvey",
      "normalized": "HARVEY",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "HARVEY AI",
      "legal_names": [
        "Counsel AI Corporation",
        "HARVEY AI CORPORATION"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 22,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PLAYA DEL REY",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Headway",
      "normalized": "HEADWAY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "THERAPYMATCH INC DBA HEADWAY",
      "legal_names": [
        "THERAPYMATCH INC DBA HEADWAY"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "HelloFresh",
      "normalized": "HELLOFRESH",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "GROCERY DELIVERY E SERVICES USA INC DBA HELLOFRESH",
      "legal_names": [
        "GROCERY DELIVERY E SERVICES USA INC DBA HELLOFRESH"
      ],
      "approvals": 33,
      "denials": 1,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "helpscout",
      "normalized": "HELPSCOUT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Hermeus",
      "normalized": "HERMEUS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Hightouch",
      "normalized": "HIGHTOUCH",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "honor",
      "normalized": "HONOR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HONOR TECHNOLOGY",
      "legal_names": [
        "HONOR TECH INC",
        "HONOR TECHNOLOGY INC",
        "Honor Technology, Inc."
      ],
      "approvals": 12,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO",
        "SAN MATEO"
      ]
    },
    {
      "company": "HubSpot",
      "normalized": "HUBSPOT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HUBSPOT",
      "legal_names": [
        "HUBSPOT INC",
        "HubSpot, Inc",
        "HubSpot, Inc."
      ],
      "approvals": 213,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 142,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "CAMBRIDGE"
      ]
    },
    {
      "company": "Huckberry",
      "normalized": "HUCKBERRY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Hudson River Trading",
      "normalized": "HUDSON RIVER TRADING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HUDSON RIVER TRADING",
      "legal_names": [
        "HUDSON RIVER TRADING LLC",
        "Hudson River Trading LLC"
      ],
      "approvals": 37,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 27,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Huzzle",
      "normalized": "HUZZLE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "IMC Trading",
      "normalized": "IMC TRADING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "IMC AMERICAS",
      "legal_names": [
        "IMC AMERICAS INC",
        "IMC AMERICAS, INC.",
        "IMC Americas, Inc.",
        "IMC MANAGER LLC"
      ],
      "approvals": 38,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 21,
      "filing_states": [
        "GA",
        "IL"
      ],
      "filing_cities": [
        "ATLANTA",
        "CHICAGO"
      ]
    },
    {
      "company": "Impact Clients",
      "normalized": "IMPACT CLIENTS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "imply",
      "normalized": "IMPLY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "IMPLY DATA",
      "legal_names": [
        "IMPLY DATA INC",
        "Imply Data, Inc."
      ],
      "approvals": 20,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 4,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "BURLINGAME"
      ]
    },
    {
      "company": "incident",
      "normalized": "INCIDENT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Infisical",
      "normalized": "INFISICAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "inkeep",
      "normalized": "INKEEP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Inngest",
      "normalized": "INNGEST",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "INNGEST",
      "legal_names": [
        "Inngest, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "MI"
      ],
      "filing_cities": [
        "ROYAL OAK"
      ]
    },
    {
      "company": "instabase",
      "normalized": "INSTABASE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "INSTABASE",
      "legal_names": [
        "INSTABASE INC",
        "Instabase, Inc."
      ],
      "approvals": 14,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 10,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MENLO PARK",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Instacart",
      "normalized": "INSTACART",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MAPLEBEAR INC D B A INSTACART",
      "legal_names": [
        "MAPLEBEAR INC D/B/A INSTACART"
      ],
      "approvals": 432,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO",
        "SANTA CLARA"
      ]
    },
    {
      "company": "Instawork",
      "normalized": "INSTAWORK",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "GARUDA LABS INC DBA INSTAWORK",
      "legal_names": [
        "GARUDA LABS INC DBA INSTAWORK"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "intro",
      "normalized": "INTRO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "ionq",
      "normalized": "IONQ",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "IONQ",
      "legal_names": [
        "IONQ INC"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "MD"
      ],
      "filing_cities": [
        "COLLEGE PARK"
      ]
    },
    {
      "company": "Jane Street",
      "normalized": "JANE STREET",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "JANE STREET GROUP",
      "legal_names": [
        "JANE STREET GROUP LLC",
        "Jane Street Group, LLC"
      ],
      "approvals": 86,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 34,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "jfrog",
      "normalized": "JFROG",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "JFROG",
      "legal_names": [
        "JFROG INC",
        "JFROG, INC."
      ],
      "approvals": 31,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 18,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SUNNYVALE"
      ]
    },
    {
      "company": "Jump Crypto",
      "normalized": "JUMP CRYPTO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Jump Trading",
      "normalized": "JUMP TRADING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "JUMP OPERATIONS",
      "legal_names": [
        "JUMP OPERATIONS LLC",
        "JUMP OPERATIONS, LLC"
      ],
      "approvals": 86,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 59,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "justworks",
      "normalized": "JUSTWORKS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "JUSTWORKS",
      "legal_names": [
        "JUSTWORKS INC",
        "Justworks, Inc."
      ],
      "approvals": 30,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Khan Academy",
      "normalized": "KHAN ACADEMY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "KHAN ACADEMY",
      "legal_names": [
        "KHAN ACADEMY INC",
        "Khan Academy, Inc."
      ],
      "approvals": 8,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 4,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Klaviyo",
      "normalized": "KLAVIYO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "KLAVIYO",
      "legal_names": [
        "KLAVIYO INC",
        "Klaviyo, Inc."
      ],
      "approvals": 61,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 45,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON"
      ]
    },
    {
      "company": "Knock",
      "normalized": "KNOCK",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "KNOCK",
      "legal_names": [
        "KNOCK INC"
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "WA"
      ],
      "filing_cities": [
        "SEATTLE"
      ]
    },
    {
      "company": "komodohealth",
      "normalized": "KOMODOHEALTH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "KOMODO HEALTH",
      "legal_names": [
        "KOMODO HEALTH INC",
        "Komodo Health, Inc."
      ],
      "approvals": 43,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 15,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "kustomer",
      "normalized": "KUSTOMER",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "KUSTOMER",
      "legal_names": [
        "KUSTOMER INC",
        "Kustomer, LLC"
      ],
      "approvals": 8,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 4,
      "filing_states": [
        "NJ",
        "NY"
      ],
      "filing_cities": [
        "EAST BRUNSWICK",
        "NEW YORK",
        "SHORT HILLS"
      ]
    },
    {
      "company": "LangChain",
      "normalized": "LANGCHAIN",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "LANGCHAIN",
      "legal_names": [
        "LangChain Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 10,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "LatchBio",
      "normalized": "LATCHBIO",
      "sponsors": false,
      "evidence": null,
      "rejected": "LatchBio is correctly labelled (the source was renamed from \"Latch\" on 2026-07-29). LATCH SYSTEMS INC is the New York smart-lock company, a different business, and its petitions must not be credited here",
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "lattice",
      "normalized": "LATTICE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "DEGREE INC D B A LATTICE",
      "legal_names": [
        "DEGREE INC D/B/A LATTICE"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "launchdarkly",
      "normalized": "LAUNCHDARKLY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "LAUNCHDARKLY",
      "legal_names": [
        "LAUNCHDARKLY"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "OAKLAND"
      ]
    },
    {
      "company": "Lifely",
      "normalized": "LIFELY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "lightmatter",
      "normalized": "LIGHTMATTER",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "LIGHTMATTER",
      "legal_names": [
        "LIGHTMATTER INC",
        "Lightmatter, Inc."
      ],
      "approvals": 12,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 17,
      "filing_states": [
        "CA",
        "MA"
      ],
      "filing_cities": [
        "BOSTON",
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Linear",
      "normalized": "LINEAR",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "llamaindex",
      "normalized": "LLAMAINDEX",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "LLAMAINDEX",
      "legal_names": [
        "LlamaIndex Inc",
        "LlamaIndex Inc.",
        "LlamaIndex, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 5,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "lottie",
      "normalized": "LOTTIE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "LRN Corporation",
      "normalized": "LRN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "LRN",
      "legal_names": [
        "LRN CORPORATION",
        "LRN Corporation"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Lucid",
      "normalized": "LUCID",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "LUCID USA",
      "legal_names": [
        "LUCID GROUP USA INC",
        "LUCID USA INC",
        "Lucid Group USA, Inc.",
        "Lucid USA, Inc."
      ],
      "approvals": 755,
      "denials": 12,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 636,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "NEWARK"
      ]
    },
    {
      "company": "Lyft",
      "normalized": "LYFT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "LYFT",
      "legal_names": [
        "LYFT INC",
        "LYFT, Inc."
      ],
      "approvals": 586,
      "denials": 15,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 138,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "DALY CITY",
        "SAN DIEGO",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Man Group",
      "normalized": "MAN GROUP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MAN INVESTMENTS USA HOLDINGS",
      "legal_names": [
        "MAN INVESTMENTS USA HOLDINGS INC",
        "Man Investments USA Holdings Inc"
      ],
      "approvals": 26,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 11,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Manila Recruitment",
      "normalized": "MANILA RECRUITMENT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Marqeta",
      "normalized": "MARQETA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MARQETA",
      "legal_names": [
        "MARQETA INC",
        "Marqeta, Inc."
      ],
      "approvals": 187,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 54,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "OAKLAND"
      ]
    },
    {
      "company": "Marshall Wace",
      "normalized": "MARSHALL WACE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MARSHALL WACE NORTH AMERICA",
      "legal_names": [
        "MARSHALL WACE NORTH AMERICA LP",
        "Marshall Wace North America LP"
      ],
      "approvals": 11,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 5,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Match Group",
      "normalized": "MATCH GROUP",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MATCH GROUP",
      "legal_names": [
        "MATCH GROUP LLC"
      ],
      "approvals": 282,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "DALLAS"
      ]
    },
    {
      "company": "Maven Clinic",
      "normalized": "MAVEN CLINIC",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MAVEN CLINIC",
      "legal_names": [
        "MAVEN CLINIC CO",
        "Maven Clinic Co",
        "Maven Clinic Co."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 5,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Mercari, Inc. (India)",
      "normalized": "MERCARI INC INDIA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Mercata",
      "normalized": "MERCATA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Mercor",
      "normalized": "MERCOR",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Mercury",
      "normalized": "MERCURY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MERCURY TECHNOLOGIES",
      "legal_names": [
        "MERCURY TECHNOLOGIES INC",
        "Mercury Technologies, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 17,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Merge",
      "normalized": "MERGE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MERGE API",
      "legal_names": [
        "MERGE API INC",
        "Merge API, Inc.",
        "PARTNERS SIMONS INC D B A MERGE",
        "PARTNERS SIMONS INC DBA MERGE"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA",
        "IL"
      ],
      "filing_cities": [
        "CHICAGO",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Middle Seat",
      "normalized": "MIDDLE SEAT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Mixpanel",
      "normalized": "MIXPANEL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MIXPANEL",
      "legal_names": [
        "MIXPANEL INC",
        "Mixpanel Inc."
      ],
      "approvals": 32,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 11,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Modal",
      "normalized": "MODAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Modern Family Law",
      "normalized": "MODERN FAMILY LAW",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "modernhealth",
      "normalized": "MODERNHEALTH",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MODERN LIFE INC DBA MODERN HEALTH",
      "legal_names": [
        "MODERN LIFE INC DBA MODERN HEALTH"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "MongoDB",
      "normalized": "MONGODB",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MONGODB",
      "legal_names": [
        "MONGODB INC",
        "MONGODB, INC."
      ],
      "approvals": 146,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 144,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Monzo",
      "normalized": "MONZO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Motional",
      "normalized": "MOTIONAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Motive",
      "normalized": "MOTIVE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Mozilla",
      "normalized": "MOZILLA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MOZILLA",
      "legal_names": [
        "MOZILLA CORP",
        "MOZILLA CORPORATION",
        "Mozilla Corporation"
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "N26",
      "normalized": "N26",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "N26",
      "legal_names": [
        "N26 INC"
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Namespace",
      "normalized": "NAMESPACE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "nanonets",
      "normalized": "NANONETS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "natera",
      "normalized": "NATERA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NATERA",
      "legal_names": [
        "NATERA INC",
        "Natera, Inc."
      ],
      "approvals": 171,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 90,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN CARLOS"
      ]
    },
    {
      "company": "Nava PBC",
      "normalized": "NAVA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Navan",
      "normalized": "NAVAN",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "NAVAN",
      "legal_names": [
        "Navan, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 45,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO"
      ]
    },
    {
      "company": "Netlify",
      "normalized": "NETLIFY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "NETLIFY",
      "legal_names": [
        "NETLIFY INC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Newsela",
      "normalized": "NEWSELA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NEWSELA",
      "legal_names": [
        "NEWSELA INC",
        "Newsela, Inc."
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Notion",
      "normalized": "NOTION",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NOTION LABS",
      "legal_names": [
        "NOTION LABS INC",
        "Notion Labs, Inc."
      ],
      "approvals": 39,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 30,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Nuro",
      "normalized": "NURO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NURO",
      "legal_names": [
        "NURO INC",
        "Nuro, Inc"
      ],
      "approvals": 206,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 51,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Okta",
      "normalized": "OKTA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OKTA",
      "legal_names": [
        "OKTA INC",
        "Okta, Inc."
      ],
      "approvals": 366,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 117,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO",
        "SAN JOSE"
      ]
    },
    {
      "company": "Old Mission",
      "normalized": "OLD MISSION",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OLD MISSION CAPITAL",
      "legal_names": [
        "OLD MISSION CAPITAL LLC",
        "Old Mission Capital, LLC"
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 3,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "omadahealth",
      "normalized": "OMADAHEALTH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OMADA HEALTH",
      "legal_names": [
        "OMADA HEALTH INC",
        "OMADA HEALTH INC."
      ],
      "approvals": 13,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 4,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "onemedical",
      "normalized": "ONEMEDICAL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ONE MEDICAL GROUP",
      "legal_names": [
        "ONE MEDICAL GROUP INC",
        "One Medical Group, Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "opal",
      "normalized": "OPAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "OpenAI",
      "normalized": "OPENAI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OPENAI",
      "legal_names": [
        "OPENAI INC",
        "OPENAI LP",
        "OpenAI, L.L.C."
      ],
      "approvals": 27,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "OpenEvidence",
      "normalized": "OPENEVIDENCE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "OpenGov",
      "normalized": "OPENGOV",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OPENGOV",
      "legal_names": [
        "OPENGOV INC",
        "OpenGov, Inc."
      ],
      "approvals": 18,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 22,
      "filing_states": [
        "CA",
        "WI"
      ],
      "filing_cities": [
        "MILWAUKEE",
        "SAN FRANCISCO",
        "SAN JOSE"
      ]
    },
    {
      "company": "openzeppelin",
      "normalized": "OPENZEPPELIN",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Opslevel",
      "normalized": "OPSLEVEL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Optiver",
      "normalized": "OPTIVER",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "orca",
      "normalized": "ORCA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Oscar Health",
      "normalized": "OSCAR HEALTH",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "PagerDuty",
      "normalized": "PAGERDUTY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PAGERDUTY",
      "legal_names": [
        "PAGERDUTY INC",
        "PAGERDUTY, INC."
      ],
      "approvals": 24,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 4,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Palantir",
      "normalized": "PALANTIR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PALANTIR TECHNOLOGIES",
      "legal_names": [
        "PALANTIR TECHNOLOGIES INC",
        "PALANTIR TECHNOLOGIES INC."
      ],
      "approvals": 134,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 111,
      "filing_states": [
        "CA",
        "CO"
      ],
      "filing_cities": [
        "DENVER",
        "PALO ALTO"
      ]
    },
    {
      "company": "papa",
      "normalized": "PAPA",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "PAPA",
      "legal_names": [
        "PAPA INC"
      ],
      "approvals": 8,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "FL"
      ],
      "filing_cities": [
        "MIAMI"
      ]
    },
    {
      "company": "parsleyhealth",
      "normalized": "PARSLEYHEALTH",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "payabl.",
      "normalized": "PAYABL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Pearl",
      "normalized": "PEARL",
      "sponsors": false,
      "evidence": null,
      "rejected": "the Workable account is Pearl Talent, a recruiting firm placing staff with client companies. A bare PEARL INC filing does not establish that it belongs to this employer",
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Peloton",
      "normalized": "PELOTON",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PELOTON INTERACTIVE",
      "legal_names": [
        "PELOTON INTERACTIVE INC",
        "Peloton Interactive, Inc."
      ],
      "approvals": 191,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 49,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK",
        "NEW YORK CITY"
      ]
    },
    {
      "company": "Perplexity",
      "normalized": "PERPLEXITY",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "PERPLEXITY AI",
      "legal_names": [
        "Perplexity AI, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 10,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Peter Lucas Project Management Inc.",
      "normalized": "PETER LUCAS PROJECT MANAGEMENT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "phonepe",
      "normalized": "PHONEPE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PHONEPE PRIVATE",
      "legal_names": [
        "PHONEPE PRIVATE LTD",
        "PhonePe Limited",
        "PhonePe Private Limited"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 7,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "EL SEGUNDO",
        "MENLO PARK"
      ]
    },
    {
      "company": "Physical Intelligence",
      "normalized": "PHYSICAL INTELLIGENCE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "PHYSICAL INTELLIGENCE PI",
      "legal_names": [
        "Physical Intelligence (PI), Inc.",
        "Physical Intelligence PI Inc"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 4,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Pinecone",
      "normalized": "PINECONE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PINECONE SYSTEMS",
      "legal_names": [
        "PINECONE SYSTEMS INC",
        "Pinecone Systems, Inc."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 3,
      "filing_states": [
        "CA",
        "NY"
      ],
      "filing_cities": [
        "BELMONT",
        "NEW YORK",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Pinely",
      "normalized": "PINELY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Pinterest",
      "normalized": "PINTEREST",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PINTEREST",
      "legal_names": [
        "PINTEREST INC",
        "Pinterest, Inc."
      ],
      "approvals": 502,
      "denials": 17,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 355,
      "filing_states": [
        "CA",
        "VA"
      ],
      "filing_cities": [
        "ARLINGTON",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Planet",
      "normalized": "PLANET",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "PlanetScale",
      "normalized": "PLANETSCALE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "PLANETSCALE",
      "legal_names": [
        "PLANETSCALE INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Point72",
      "normalized": "POINT72",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "POINT72",
      "legal_names": [
        "POINT72 ASSET MANAGEMENT LP",
        "POINT72 LP",
        "Point72 Asset Management, L.P."
      ],
      "approvals": 179,
      "denials": 7,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 41,
      "filing_states": [
        "CT"
      ],
      "filing_cities": [
        "STAMFORD"
      ]
    },
    {
      "company": "Poolside",
      "normalized": "POOLSIDE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "POOLSIDE",
      "legal_names": [
        "Poolside, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Portless",
      "normalized": "PORTLESS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "postman",
      "normalized": "POSTMAN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "POSTMAN",
      "legal_names": [
        "POSTMAN INC",
        "Postman, Inc."
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 17,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "prefect",
      "normalized": "PREFECT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Protolabs",
      "normalized": "PROTOLABS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "psiquantum",
      "normalized": "PSIQUANTUM",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PSIQUANTUM",
      "legal_names": [
        "PSIQUANTUM CORP",
        "PsiQuantum Corp."
      ],
      "approvals": 11,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 12,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO"
      ]
    },
    {
      "company": "Pure Storage",
      "normalized": "PURE STORAGE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PURE STORAGE",
      "legal_names": [
        "PURE STORAGE INC",
        "PURE STORAGE, INC.",
        "Pure Storage, Inc."
      ],
      "approvals": 353,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 162,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW",
        "SANTA CLARA"
      ]
    },
    {
      "company": "Quadrature",
      "normalized": "QUADRATURE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "QUADRATURE US",
      "legal_names": [
        "QUADRATURE US INC",
        "Quadrature US, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 7,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Qube Research & Technologies",
      "normalized": "QUBE RESEARCH AND TECHNOLOGIES",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "quintoandar",
      "normalized": "QUINTOANDAR",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Railway",
      "normalized": "RAILWAY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Ramp",
      "normalized": "RAMP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RAMP BUSINESS",
      "legal_names": [
        "RAMP BUSINESS CORPORATION",
        "Ramp Business Corporation"
      ],
      "approvals": 13,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 29,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Recorded Future",
      "normalized": "RECORDED FUTURE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RECORDED FUTURE",
      "legal_names": [
        "RECORDED FUTURE INC",
        "Recorded Future Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "SOMERVILLE"
      ]
    },
    {
      "company": "Recursion",
      "normalized": "RECURSION",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RECURSION",
      "legal_names": [
        "RECURSION CO",
        "Recursion Co."
      ],
      "approvals": 4,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Reddit",
      "normalized": "REDDIT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "REDDIT",
      "legal_names": [
        "REDDIT INC",
        "Reddit, Inc."
      ],
      "approvals": 147,
      "denials": 5,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 98,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Redwood Materials",
      "normalized": "REDWOOD MATERIALS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "REDWOOD MATERIALS",
      "legal_names": [
        "REDWOOD MATERIALS INC",
        "REDWOOD MATERIALS, INC."
      ],
      "approvals": 12,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 36,
      "filing_states": [
        "NV"
      ],
      "filing_cities": [
        "CARSON CITY"
      ]
    },
    {
      "company": "Reflection AI",
      "normalized": "REFLECTION AI",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "REFLECTION AI",
      "legal_names": [
        "Reflection AI Inc.",
        "Reflection AI, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 10,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "BROOKLYN"
      ]
    },
    {
      "company": "Relativity Space",
      "normalized": "RELATIVITY SPACE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Remote",
      "normalized": "REMOTE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Remote Raven",
      "normalized": "REMOTE RAVEN",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Render",
      "normalized": "RENDER",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "RENDER SERVICES",
      "legal_names": [
        "RENDER SERVICES INC"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Rent the Runway",
      "normalized": "RENT THE RUNWAY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RENT THE RUNWAY",
      "legal_names": [
        "RENT THE RUNWAY INC",
        "Rent the Runway, Inc."
      ],
      "approvals": 17,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 5,
      "filing_states": [
        "NJ",
        "NY"
      ],
      "filing_cities": [
        "BROOKLYN",
        "NEW YORK",
        "SECAUCUS"
      ]
    },
    {
      "company": "Replit",
      "normalized": "REPLIT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "REPLIT",
      "legal_names": [
        "REPLIT INC",
        "Replit Inc",
        "Replit Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 16,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "FOSTER CITY",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Resend",
      "normalized": "RESEND",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Riot Games",
      "normalized": "RIOT GAMES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RIOT GAMES",
      "legal_names": [
        "RIOT GAMES INC",
        "Riot Games, Inc."
      ],
      "approvals": 168,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 95,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "LOS ANGELES"
      ]
    },
    {
      "company": "ripple",
      "normalized": "RIPPLE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RIPPLE LABS",
      "legal_names": [
        "RIPPLE LABS INC",
        "Ripple Labs, Inc."
      ],
      "approvals": 79,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 44,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Robinhood",
      "normalized": "ROBINHOOD",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ROBINHOOD MARKETS",
      "legal_names": [
        "ROBINHOOD MARKETS INC",
        "Robinhood Markets, Inc."
      ],
      "approvals": 540,
      "denials": 12,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 167,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MENLO PARK",
        "MENLO PARK C"
      ]
    },
    {
      "company": "Roblox",
      "normalized": "ROBLOX",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ROBLOX",
      "legal_names": [
        "ROBLOX CORPORATION",
        "Roblox Corporation"
      ],
      "approvals": 268,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 244,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN MATEO"
      ]
    },
    {
      "company": "Rocket Lab",
      "normalized": "ROCKET LAB",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Rockstar",
      "normalized": "ROCKSTAR",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "rogo",
      "normalized": "ROGO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Roku",
      "normalized": "ROKU",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ROKU",
      "legal_names": [
        "ROKU INC",
        "Roku, Inc."
      ],
      "approvals": 452,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 114,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "LOS GATOS",
        "SAN JOSE"
      ]
    },
    {
      "company": "Rondo Energy",
      "normalized": "RONDO ENERGY",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "RONDO ENERGY",
      "legal_names": [
        "Rondo Energy, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 5,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "ALAMEDA"
      ]
    },
    {
      "company": "Rubrik",
      "normalized": "RUBRIK",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "RUBRIK",
      "legal_names": [
        "RUBRIK INC",
        "Rubrik, Inc."
      ],
      "approvals": 251,
      "denials": 5,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 118,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALI ALTO",
        "PALO ALTO",
        "PALTO ALTO"
      ]
    },
    {
      "company": "Runware",
      "normalized": "RUNWARE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "rutter",
      "normalized": "RUTTER",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "LANGAPI COMPANY D B A RUTTER",
      "legal_names": [
        "LANGAPI COMPANY D B A RUTTER",
        "LANGAPI COMPANY D/B/A RUTTER"
      ],
      "approvals": 8,
      "denials": 2,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA",
        "NY"
      ],
      "filing_cities": [
        "NEW YORK",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "safebreach",
      "normalized": "SAFEBREACH",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Sago",
      "normalized": "SAGO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "salesloft",
      "normalized": "SALESLOFT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SALESLOFT",
      "legal_names": [
        "SALESLOFT INC",
        "Salesloft, Inc."
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 4,
      "filing_states": [
        "GA"
      ],
      "filing_cities": [
        "ATLANTA"
      ]
    },
    {
      "company": "Samsara",
      "normalized": "SAMSARA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SAMSARA",
      "legal_names": [
        "SAMSARA INC",
        "Samsara Inc."
      ],
      "approvals": 71,
      "denials": 3,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 68,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "sanity",
      "normalized": "SANITY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "SAP Fioneer",
      "normalized": "SAP FIONEER",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Saronic",
      "normalized": "SARONIC",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Scale AI",
      "normalized": "SCALE AI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SCALE AI",
      "legal_names": [
        "SCALE AI INC",
        "Scale AI, Inc."
      ],
      "approvals": 74,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 128,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Schonfeld",
      "normalized": "SCHONFELD",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Science 37",
      "normalized": "SCIENCE 37",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SCIENCE 37",
      "legal_names": [
        "SCIENCE 37 INC",
        "SCIENCE 37, INC."
      ],
      "approvals": 27,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "CULVER CITY",
        "LOS ANGELES"
      ]
    },
    {
      "company": "scopely",
      "normalized": "SCOPELY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SCOPELY",
      "legal_names": [
        "SCOPELY INC",
        "Scopely, Inc",
        "Scopely, Inc."
      ],
      "approvals": 39,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 16,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "CULVER",
        "CULVER CITY"
      ]
    },
    {
      "company": "SeatGeek",
      "normalized": "SEATGEEK",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SEATGEEK",
      "legal_names": [
        "SEATGEEK INC",
        "SeatGeek, Inc."
      ],
      "approvals": 13,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Sedona Digital",
      "normalized": "SEDONA DIGITAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "semgrep",
      "normalized": "SEMGREP",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "SEMGREP",
      "legal_names": [
        "Semgrep, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 10,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Shield AI",
      "normalized": "SHIELD AI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SHIELD AI",
      "legal_names": [
        "SHIELD AI INC",
        "Shield AI, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN DIEGO"
      ]
    },
    {
      "company": "Sierra",
      "normalized": "SIERRA",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "sifflet",
      "normalized": "SIFFLET",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Sigma",
      "normalized": "SIGMA",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SIGMA",
      "legal_names": [
        "SIGMA CORPORATION"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "CREAM RIDGE"
      ]
    },
    {
      "company": "signoz",
      "normalized": "SIGNOZ",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "singlestore",
      "normalized": "SINGLESTORE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SINGLESTORE",
      "legal_names": [
        "SINGLESTORE INC",
        "SingleStore Inc.",
        "SingleStore, Inc."
      ],
      "approvals": 22,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 13,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Skydio",
      "normalized": "SKYDIO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SKYDIO",
      "legal_names": [
        "SKYDIO INC",
        "Skydio, Inc."
      ],
      "approvals": 42,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 28,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY",
        "SAN MATEO"
      ]
    },
    {
      "company": "skyflow",
      "normalized": "SKYFLOW",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SKYFLOW",
      "legal_names": [
        "SKYFLOW INC",
        "Skyflow Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "PALO ALTO"
      ]
    },
    {
      "company": "Skylight",
      "normalized": "SKYLIGHT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Snowflake",
      "normalized": "SNOWFLAKE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SNOWFLAKE",
      "legal_names": [
        "SNOWFLAKE INC",
        "Snowflake Inc."
      ],
      "approvals": 449,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 385,
      "filing_states": [
        "CA",
        "MT"
      ],
      "filing_cities": [
        "BOZEMAN",
        "MENLO PARK",
        "SAN MATEO"
      ]
    },
    {
      "company": "socket",
      "normalized": "SOCKET",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "SoFi",
      "normalized": "SOFI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SOCIAL FINANCE",
      "legal_names": [
        "SOCIAL FINANCE INC",
        "Social Finance, LLC"
      ],
      "approvals": 208,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 206,
      "filing_states": [
        "CA",
        "MT"
      ],
      "filing_cities": [
        "HELENA",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Sophos",
      "normalized": "SOPHOS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SOPHOS",
      "legal_names": [
        "SOPHOS INC",
        "Sophos, Inc."
      ],
      "approvals": 92,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 48,
      "filing_states": [
        "MA",
        "TX"
      ],
      "filing_cities": [
        "BURLINGTON",
        "DALLAS"
      ]
    },
    {
      "company": "SpaceX",
      "normalized": "SPACEX",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SPACE EXPLORATION TECHNOLOGIES",
      "legal_names": [
        "SPACE EXPLORATION TECHNOLOGIES CORP",
        "SPACE EXPLORATION TECHNOLOGIES CORPORATION",
        "Space Exploration Technologies",
        "Space Exploration Technologies Corp."
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 21,
      "filing_states": [
        "CA",
        "TX"
      ],
      "filing_cities": [
        "BROWNSVILLE",
        "HAWTHORNE"
      ]
    },
    {
      "company": "Spotify",
      "normalized": "SPOTIFY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SPOTIFY USA",
      "legal_names": [
        "SPOTIFY USA INC",
        "SPOTIFY USA, INC."
      ],
      "approvals": 323,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 140,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Squarepoint Capital",
      "normalized": "SQUAREPOINT CAPITAL",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Squarespace",
      "normalized": "SQUARESPACE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SQUARESPACE",
      "legal_names": [
        "SQUARESPACE INC",
        "SQUARESPACE, INC."
      ],
      "approvals": 52,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 23,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "starburst",
      "normalized": "STARBURST",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "STARBURST DATA",
      "legal_names": [
        "STARBURST DATA INC",
        "Starburst Data, Inc."
      ],
      "approvals": 19,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 6,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON",
        "MEDFIELD"
      ]
    },
    {
      "company": "StockX",
      "normalized": "STOCKX",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "STOCKX",
      "legal_names": [
        "STOCKX LLC",
        "StockX LLC"
      ],
      "approvals": 43,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 3,
      "filing_states": [
        "MI"
      ],
      "filing_cities": [
        "DETROIT"
      ]
    },
    {
      "company": "stone",
      "normalized": "STONE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Street Child",
      "normalized": "STREET CHILD",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Stripe",
      "normalized": "STRIPE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "STRIPE",
      "legal_names": [
        "STRIPE INC",
        "Stripe, Inc."
      ],
      "approvals": 664,
      "denials": 12,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 279,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "S SAN FRAN",
        "S SAN FRANCISCO",
        "SAN FRANCISCO",
        "SOUTH SAN FRAN",
        "SOUTH SAN FRANCISCO"
      ]
    },
    {
      "company": "Stytch",
      "normalized": "STYTCH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "STYTCH",
      "legal_names": [
        "STYTCH INC",
        "Stytch, Inc."
      ],
      "approvals": 2,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Suade",
      "normalized": "SUADE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "suki",
      "normalized": "SUKI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SUKI AI",
      "legal_names": [
        "SUKI AI INC",
        "Suki AI, Inc."
      ],
      "approvals": 8,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 8,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "Suno",
      "normalized": "SUNO",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "SUNO",
      "legal_names": [
        "Suno Inc.",
        "Suno, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 6,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "CAMBRIDGE"
      ]
    },
    {
      "company": "Supabase",
      "normalized": "SUPABASE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SUPABASE",
      "legal_names": [
        "SUPABASE INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "DE"
      ],
      "filing_cities": [
        "NEWARK"
      ]
    },
    {
      "company": "SupportYourApp",
      "normalized": "SUPPORTYOURAPP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "sweetgreen",
      "normalized": "SWEETGREEN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SWEETGREEN",
      "legal_names": [
        "SWEETGREEN INC",
        "Sweetgreen, Inc."
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "LOS ANGELES"
      ]
    },
    {
      "company": "Take-Two",
      "normalized": "TAKE TWO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TAKE TWO INTERACTIVE SOFTWARE",
      "legal_names": [
        "TAKE TWO INTERACTIVE SOFTWARE INC",
        "TAKE-TWO INTERACTIVE SOFTWARE INC",
        "Take-Two Interactive Software, Inc."
      ],
      "approvals": 26,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 7,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Tala",
      "normalized": "TALA",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "INVENTURE CAPITAL CORP D B A TALA",
      "legal_names": [
        "INVENTURE CAPITAL CORP D/B/A TALA",
        "INVENTURE CAPITAL CORPORATION D/B/A TALA"
      ],
      "approvals": 32,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SANTA MONICA"
      ]
    },
    {
      "company": "talkspace",
      "normalized": "TALKSPACE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "TALKSPACE",
      "legal_names": [
        "TALKSPACE INC"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "tebra",
      "normalized": "TEBRA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TEBRA TECHNOLOGIES",
      "legal_names": [
        "TEBRA TECHNOLOGIES INC",
        "Tebra Technologies, Inc."
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "CORONA DEL MAR"
      ]
    },
    {
      "company": "tenstorrent",
      "normalized": "TENSTORRENT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TENSTORRENT USA",
      "legal_names": [
        "TENSTORRENT USA INC",
        "Tenstorrent USA Inc.",
        "Tenstorrent USA, Inc."
      ],
      "approvals": 18,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 51,
      "filing_states": [
        "CA",
        "TX"
      ],
      "filing_cities": [
        "AUSTIN",
        "SANTA CLARA"
      ]
    },
    {
      "company": "The New York Times",
      "normalized": "THE NEW YORK TIMES",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Toast",
      "normalized": "TOAST",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TOAST",
      "legal_names": [
        "KUDDAGE II INC DBA TOAST",
        "TOAST INC",
        "Toast Inc.",
        "Toast, Inc."
      ],
      "approvals": 86,
      "denials": 5,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 26,
      "filing_states": [
        "MA",
        "NY"
      ],
      "filing_cities": [
        "BOSTON",
        "PATCHOGUE"
      ]
    },
    {
      "company": "Together AI",
      "normalized": "TOGETHER AI",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Tower Research",
      "normalized": "TOWER RESEARCH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TOWER RESEARCH CAPITAL",
      "legal_names": [
        "TOWER RESEARCH CAPITAL LLC",
        "Tower Research Capital LLC"
      ],
      "approvals": 54,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 30,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK",
        "NEW YORK CITY"
      ]
    },
    {
      "company": "Town Web",
      "normalized": "TOWN WEB",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "TransMarket Group",
      "normalized": "TRANSMARKET GROUP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "TripAdvisor",
      "normalized": "TRIPADVISOR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TRIPADVISOR",
      "legal_names": [
        "TRIPADVISOR LLC",
        "TripAdvisor LLC"
      ],
      "approvals": 99,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 34,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "NEEDHAM",
        "NEEDHAM HEIGHTS"
      ]
    },
    {
      "company": "Trustly",
      "normalized": "TRUSTLY",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "truveta",
      "normalized": "TRUVETA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TRUVETA",
      "legal_names": [
        "TRUVETA INC",
        "Truveta, Inc."
      ],
      "approvals": 24,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 15,
      "filing_states": [
        "WA"
      ],
      "filing_cities": [
        "BELLEVUE",
        "REDMOND"
      ]
    },
    {
      "company": "Twilio",
      "normalized": "TWILIO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TWILIO",
      "legal_names": [
        "TWILIO INC",
        "Twilio, Inc."
      ],
      "approvals": 600,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 192,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Twist Bioscience",
      "normalized": "TWIST BIOSCIENCE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TWIST BIOSCIENCE",
      "legal_names": [
        "TWIST BIOSCIENCE CORPORATION",
        "Twist Bioscience Corporation"
      ],
      "approvals": 31,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 17,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "S SAN FRAN",
        "SOUTH SAN FRANCISCO"
      ]
    },
    {
      "company": "Twitch",
      "normalized": "TWITCH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TWITCH INTERACTIVE",
      "legal_names": [
        "TWITCH INTERACTIVE INC",
        "TWITCH INTERACTIVE, INC.",
        "Twitch Interactive, Inc."
      ],
      "approvals": 208,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 60,
      "filing_states": [
        "VA",
        "WA"
      ],
      "filing_cities": [
        "ARLINGTON",
        "SEATTLE",
        "TEST CITY"
      ]
    },
    {
      "company": "Udemy",
      "normalized": "UDEMY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "UDEMY",
      "legal_names": [
        "UDEMY INC",
        "Udemy, Inc."
      ],
      "approvals": 57,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 19,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Unit",
      "normalized": "UNIT",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "unstructured",
      "normalized": "UNSTRUCTURED",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "validio",
      "normalized": "VALIDIO",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Vannevar Labs",
      "normalized": "VANNEVAR LABS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Vanta",
      "normalized": "VANTA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VANTA",
      "legal_names": [
        "VANTA INC",
        "Vanta Inc."
      ],
      "approvals": 15,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 23,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Varda Space Industries",
      "normalized": "VARDA SPACE INDUSTRIES",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Vatic Labs",
      "normalized": "VATIC LABS",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "veracode",
      "normalized": "VERACODE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VERACODE",
      "legal_names": [
        "VERACODE INC",
        "Veracode, Inc."
      ],
      "approvals": 28,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BURLINGTON"
      ]
    },
    {
      "company": "veracyte",
      "normalized": "VERACYTE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VERACYTE",
      "legal_names": [
        "VERACYTE INC",
        "Veracyte, Inc."
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 8,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "S SAN FRAN",
        "SOUTH SAN FRANCISCO"
      ]
    },
    {
      "company": "Vercel",
      "normalized": "VERCEL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VERCEL",
      "legal_names": [
        "VERCEL INC",
        "Vercel Inc.",
        "Vercel, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 4,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "COVINA",
        "WALNUT"
      ]
    },
    {
      "company": "Verkada",
      "normalized": "VERKADA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VERKADA",
      "legal_names": [
        "VERKADA INC",
        "Verkada Inc",
        "Verkada Inc.",
        "Verkada, Inc"
      ],
      "approvals": 87,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 63,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN MATEO"
      ]
    },
    {
      "company": "Virtu",
      "normalized": "VIRTU",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VIRTU FINANCIAL OPERATING",
      "legal_names": [
        "VIRTU FINANCIAL OPERATING LLC",
        "VIRTUAL FRAMEWORKS INC D/B/A VIRTU",
        "Virtu Financial Operating LLC"
      ],
      "approvals": 63,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 24,
      "filing_states": [
        "FL",
        "NY"
      ],
      "filing_cities": [
        "NEW YORK",
        "TAMPA"
      ]
    },
    {
      "company": "Vitesse PSP",
      "normalized": "VITESSE PSP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Vox Media Group",
      "normalized": "VOX MEDIA GROUP",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Waymo",
      "normalized": "WAYMO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WAYMO",
      "legal_names": [
        "WAYMO LLC",
        "Waymo LLC"
      ],
      "approvals": 459,
      "denials": 5,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 231,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Weaviate",
      "normalized": "WEAVIATE",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Webflow",
      "normalized": "WEBFLOW",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WEBFLOW",
      "legal_names": [
        "WEBFLOW INC",
        "Webflow, Inc."
      ],
      "approvals": 12,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 7,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "webook.com",
      "normalized": "WEBOOK COM",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Wiz",
      "normalized": "WIZ",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WIZ",
      "legal_names": [
        "WIZ INC",
        "Wiz Inc."
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "workboard",
      "normalized": "WORKBOARD",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "WORKBOARD",
      "legal_names": [
        "WORKBOARD INC"
      ],
      "approvals": 11,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "WorkMotion",
      "normalized": "WORKMOTION",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "WorkOS",
      "normalized": "WORKOS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WORKOS",
      "legal_names": [
        "WORKOS INC",
        "WorkOS, Inc."
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "WorldQuant",
      "normalized": "WORLDQUANT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WORLDQUANT",
      "legal_names": [
        "WORLDQUANT LLC",
        "WorldQuant, LLC"
      ],
      "approvals": 80,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 18,
      "filing_states": [
        "CT"
      ],
      "filing_cities": [
        "OLD GREENWICH"
      ]
    },
    {
      "company": "Wrisk",
      "normalized": "WRISK",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "yugabyte",
      "normalized": "YUGABYTE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "YUGABYTE",
      "legal_names": [
        "YUGABYTE INC"
      ],
      "approvals": 40,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SUNNYVALE"
      ]
    },
    {
      "company": "Zed",
      "normalized": "ZED",
      "sponsors": false,
      "evidence": null,
      "matched_key": null,
      "legal_names": [],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 0,
      "filing_states": [],
      "filing_cities": []
    },
    {
      "company": "Zocdoc",
      "normalized": "ZOCDOC",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ZOCDOC",
      "legal_names": [
        "ZOCDOC INC",
        "ZOCDOC, INC.",
        "Zocdoc, Inc."
      ],
      "approvals": 23,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 10,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "zoominfo",
      "normalized": "ZOOMINFO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ZOOMINFO TECHNOLOGIES",
      "legal_names": [
        "ZOOMINFO TECH LLC DBA ZOOMINFO",
        "ZOOMINFO TECHNOLOGIES LLC",
        "ZoomInfo Technologies, LLC"
      ],
      "approvals": 200,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 70,
      "filing_states": [
        "WA"
      ],
      "filing_cities": [
        "VANCOUVER"
      ]
    },
    {
      "company": "Zscaler",
      "normalized": "ZSCALER",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ZSCALER",
      "legal_names": [
        "ZSCALER INC",
        "Zscaler, Inc."
      ],
      "approvals": 237,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 159,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN JOSE"
      ]
    }
  ]
};
