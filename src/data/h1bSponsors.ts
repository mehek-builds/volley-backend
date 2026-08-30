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
      "company": "2K",
      "normalized": "2K",
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
      "company": "3 Day Blinds (Sales)",
      "normalized": "3 DAY BLINDS SALES",
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
      "company": "A11",
      "normalized": "A11",
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
      "company": "AB InBev  | Growth Group",
      "normalized": "AB INBEV GROWTH GROUP",
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
      "company": "ABC Legal Services",
      "normalized": "ABC LEGAL SERVICES",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ABC LEGAL SERVICES",
      "legal_names": [
        "ABC LEGAL SERVICES LLC"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2023
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
      "company": "Acadia Pharmaceuticals Inc.",
      "normalized": "ACADIA PHARMACEUTICALS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ACADIA PHARMACEUTICALS",
      "legal_names": [
        "ACADIA PHARMACEUTICALS INC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN DIEGO"
      ]
    },
    {
      "company": "ACCEL Schools",
      "normalized": "ACCEL SCHOOLS",
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
      "company": "Accenture Federal Services",
      "normalized": "ACCENTURE FEDERAL SERVICES",
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
      "company": "Accordion",
      "normalized": "ACCORDION",
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
      "company": "aCommerce",
      "normalized": "ACOMMERCE",
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
      "company": "Acorn Health",
      "normalized": "ACORN HEALTH",
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
      "company": "ACT Power Services",
      "normalized": "ACT POWER SERVICES",
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
      "company": "Addepar",
      "normalized": "ADDEPAR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ADDEPAR",
      "legal_names": [
        "ADDEPAR INC",
        "Addepar, Inc."
      ],
      "approvals": 54,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 34,
      "filing_states": [
        "CA",
        "NY"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW",
        "NEW YORK"
      ]
    },
    {
      "company": "Advanced Technology Services",
      "normalized": "ADVANCED TECHNOLOGY SERVICES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ADVANCED TECHNOLOGY SERVICES",
      "legal_names": [
        "ADVANCED TECHNOLOGY SERVICES INC",
        "Advanced Technology Services, Inc."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 1,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "PEORIA"
      ]
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
      "company": "AEG Worldwide",
      "normalized": "AEG WORLDWIDE",
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
      "company": "AGE Solutions",
      "normalized": "AGE SOLUTIONS",
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
      "company": "Agibank",
      "normalized": "AGIBANK",
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
      "company": "Agility Robotics",
      "normalized": "AGILITY ROBOTICS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AGILITY ROBOTICS",
      "legal_names": [
        "AGILITY ROBOTICS INC",
        "Agility Robotics Inc."
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 16,
      "filing_states": [
        "OR"
      ],
      "filing_cities": [
        "ALBANY",
        "SALEM",
        "TANGENT"
      ]
    },
    {
      "company": "Agoda",
      "normalized": "AGODA",
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
      "company": "AirTrunk",
      "normalized": "AIRTRUNK",
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
      "company": "AKQA",
      "normalized": "AKQA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AKQA",
      "legal_names": [
        "AKQA CORPORATION",
        "AKQA INC",
        "AKQA, Inc."
      ],
      "approvals": 17,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 5,
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
      "company": "Alan",
      "normalized": "ALAN",
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
      "company": "Alarm.com",
      "normalized": "ALARM COM",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ALARM COM",
      "legal_names": [
        "ALARM.COM INCORPORATED",
        "Alarm.com Incorporated"
      ],
      "approvals": 34,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 11,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "MC LEAN",
        "MCLEAN"
      ]
    },
    {
      "company": "Allen Integrated Solutions",
      "normalized": "ALLEN INTEGRATED SOLUTIONS",
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
      "company": "ALO",
      "normalized": "ALO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ALO",
      "legal_names": [
        "ALO LLC",
        "Alo LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 17,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "BEVERLY HILLS"
      ]
    },
    {
      "company": "Alpaca",
      "normalized": "ALPACA",
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
      "company": "Alpha Financial Markets Consulting",
      "normalized": "ALPHA FINANCIAL MARKETS CONSULTING",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "ALPHA FINANCIAL MARKETS CONSULTING",
      "legal_names": [
        "Alpha Financial Markets Consulting, Inc."
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
      "company": "AlphaSense",
      "normalized": "ALPHASENSE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ALPHASENSE",
      "legal_names": [
        "ALPHASENSE INC",
        "AlphaSense Inc."
      ],
      "approvals": 5,
      "denials": 1,
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
      "company": "AlphaSense India",
      "normalized": "ALPHASENSE INDIA",
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
      "company": "AlphaSights",
      "normalized": "ALPHASIGHTS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ALPHASIGHTS",
      "legal_names": [
        "ALPHASIGHTS INC",
        "AlphaSights Inc."
      ],
      "approvals": 8,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 6,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "ALTEN Technology USA",
      "normalized": "ALTEN TECHNOLOGY USA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ALTEN TECHNOLOGY USA",
      "legal_names": [
        "ALTEN TECHNOLOGY USA INC",
        "Alten Technology USA, Inc."
      ],
      "approvals": 117,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 94,
      "filing_states": [
        "CO",
        "MI",
        "NC"
      ],
      "filing_cities": [
        "GREENSBORO",
        "TROY",
        "WESTMINSTER"
      ]
    },
    {
      "company": "Ambiq Micro, Inc.",
      "normalized": "AMBIQ MICRO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AMBIQ MICRO",
      "legal_names": [
        "AMBIQ MICRO INC",
        "AMBIQ MICRO, INC."
      ],
      "approvals": 11,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 11,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "AUSTIN"
      ]
    },
    {
      "company": "American Antiquarian Society",
      "normalized": "AMERICAN ANTIQUARIAN SOCIETY",
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
      "company": "Amsterdam Music Harbour",
      "normalized": "AMSTERDAM MUSIC HARBOUR",
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
      "company": "Analytic Services Inc",
      "normalized": "ANALYTIC SERVICES",
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
      "company": "Anaplan",
      "normalized": "ANAPLAN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ANAPLAN",
      "legal_names": [
        "ANAPLAN INC",
        "Anaplan, Inc."
      ],
      "approvals": 150,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 24,
      "filing_states": [
        "CA",
        "FL"
      ],
      "filing_cities": [
        "MIAMI",
        "SAN FRANCISCO"
      ]
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
      "company": "AnywhereWorks",
      "normalized": "ANYWHEREWORKS",
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
      "company": "Apartment Life",
      "normalized": "APARTMENT LIFE",
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
      "company": "Apex Companies",
      "normalized": "APEX COMPANIES",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "APEX COMPANIES",
      "legal_names": [
        "APEX COMPANIES LLC"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "MD"
      ],
      "filing_cities": [
        "DERWOOD",
        "ROCKVILLE"
      ]
    },
    {
      "company": "Apex Companies - CSW",
      "normalized": "APEX COMPANIES CSW",
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
      "company": "AppDirect",
      "normalized": "APPDIRECT",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "APPDIRECT",
      "legal_names": [
        "APPDIRECT INC"
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
      "company": "Appetiser",
      "normalized": "APPETISER",
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
      "company": "Appian Corporation",
      "normalized": "APPIAN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "APPIAN",
      "legal_names": [
        "APPIAN CORPORATION",
        "Appian Corporation"
      ],
      "approvals": 70,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 33,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "MC LEAN",
        "MCLEAN"
      ]
    },
    {
      "company": "Appier",
      "normalized": "APPIER",
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
      "company": "Appnovation Technologies",
      "normalized": "APPNOVATION TECHNOLOGIES",
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
      "company": "AppsFlyer",
      "normalized": "APPSFLYER",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "APPSFLYER",
      "legal_names": [
        "APPSFLYER INC"
      ],
      "approvals": 5,
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
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Apptronik",
      "normalized": "APPTRONIK",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "APPTRONIK",
      "legal_names": [
        "APPTRONIK, INC."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 18,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "AUSTIN"
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
      "company": "Archer",
      "normalized": "ARCHER",
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
      "company": "Arco Educação",
      "normalized": "ARCO EDUCA O",
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
      "company": "Ardent",
      "normalized": "ARDENT",
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
      "company": "Armada",
      "normalized": "ARMADA",
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
      "company": "Artefact",
      "normalized": "ARTEFACT",
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
      "company": "Ascend Partner Firms",
      "normalized": "ASCEND PARTNER FIRMS",
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
      "company": "ASM",
      "normalized": "ASM",
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
      "company": "Aspire Health and Community Services",
      "normalized": "ASPIRE HEALTH AND COMMUNITY SERVICES",
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
      "company": "AST SpaceMobile",
      "normalized": "AST SPACEMOBILE",
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
      "company": "Astera Labs",
      "normalized": "ASTERA LABS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ASTERA LABS",
      "legal_names": [
        "ASTERA LABS INC",
        "Astera Labs INC",
        "Astera Labs Inc",
        "Astera Labs Inc.",
        "Astera Labs, Inc."
      ],
      "approvals": 40,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 50,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN JOSE",
        "SANTA CLARA"
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
      "company": "At Home Healthcare",
      "normalized": "AT HOME HEALTHCARE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "LHCG LVII LLC DBA AT HOME HEALTHCARE",
      "legal_names": [
        "LHCG LVII LLC DBA AT HOME HEALTHCARE"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "ALAMOSA"
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
      "company": "Atwell, LLC",
      "normalized": "ATWELL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ATWELL",
      "legal_names": [
        "ATWELL LLC",
        "Atwell, LLC"
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "MI"
      ],
      "filing_cities": [
        "SOUTHFIELD"
      ]
    },
    {
      "company": "AutoScout24",
      "normalized": "AUTOSCOUT24",
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
      "company": "Avanath",
      "normalized": "AVANATH",
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
      "company": "AvePoint",
      "normalized": "AVEPOINT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "AVEPOINT",
      "legal_names": [
        "AVEPOINT INC",
        "AvePoint, Inc."
      ],
      "approvals": 2,
      "denials": 2,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 1,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "RICHMOND"
      ]
    },
    {
      "company": "Aviation Institute of Maintenance",
      "normalized": "AVIATION INSTITUTE OF MAINTENANCE",
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
      "company": "Avride",
      "normalized": "AVRIDE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "AVRIDE",
      "legal_names": [
        "Avride, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 3,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "NEWBURYPORT"
      ]
    },
    {
      "company": "Awakened Ambition",
      "normalized": "AWAKENED AMBITION",
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
      "company": "Awin",
      "normalized": "AWIN",
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
      "company": "Axiom Talent Platform",
      "normalized": "AXIOM TALENT PLATFORM",
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
      "company": "Axle",
      "normalized": "AXLE",
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
      "company": "Axon",
      "normalized": "AXON",
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
      "company": "Axsome Therapeutics",
      "normalized": "AXSOME THERAPEUTICS",
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
      "company": "Azurity Pharmaceuticals - US",
      "normalized": "AZURITY PHARMACEUTICALS US",
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
      "company": "Backbase",
      "normalized": "BACKBASE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "BACKBASE U S A INC DBA BACKBASE",
      "legal_names": [
        "BACKBASE U S A INC DBA BACKBASE"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "GA",
        "NJ"
      ],
      "filing_cities": [
        "ATLANTA",
        "PRINCETON"
      ]
    },
    {
      "company": "Banyan Software",
      "normalized": "BANYAN SOFTWARE",
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
      "company": "Barbaricum",
      "normalized": "BARBARICUM",
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
      "company": "BAYADA Home Health Care",
      "normalized": "BAYADA HOME HEALTH CARE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BAYADA HOME HEALTH CARE",
      "legal_names": [
        "BAYADA HOME HEALTH CARE INC",
        "Bayada Home Health Care, Inc."
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
        "NC",
        "NJ"
      ],
      "filing_cities": [
        "CONCORD",
        "GREENSBORO",
        "MERCHANTVILLE",
        "PENNSAUKEN",
        "WINSTON SALEM"
      ]
    },
    {
      "company": "BDA",
      "normalized": "BDA",
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
      "company": "BEES",
      "normalized": "BEES",
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
      "company": "Behavox",
      "normalized": "BEHAVOX",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "BEHAVOX",
      "legal_names": [
        "BEHAVOX INC"
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2021
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
      "company": "Benesch",
      "normalized": "BENESCH",
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
      "company": "Berkshire Group, LLC",
      "normalized": "BERKSHIRE GROUP",
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
      "company": "Beta Bionics",
      "normalized": "BETA BIONICS",
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
      "company": "Bethesda Health Group",
      "normalized": "BETHESDA HEALTH GROUP",
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
      "company": "Betsson Group",
      "normalized": "BETSSON GROUP",
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
      "company": "Betty",
      "normalized": "BETTY",
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
      "company": "BeyondTrust",
      "normalized": "BEYONDTRUST",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BEYONDTRUST",
      "legal_names": [
        "BEYONDTRUST CORPORATION",
        "BeyondTrust Corporation"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "GA"
      ],
      "filing_cities": [
        "DULUTH",
        "JOHNS CREEK"
      ]
    },
    {
      "company": "BGE, Inc",
      "normalized": "BGE",
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
      "company": "BILL",
      "normalized": "BILL",
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
      "company": "BillionToOne",
      "normalized": "BILLIONTOONE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BILLIONTOONE",
      "legal_names": [
        "BILLIONTOONE INC",
        "BillionToOne, Inc."
      ],
      "approvals": 6,
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
        "MENLO PARK"
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
      "company": "Black Duck Software, Inc.",
      "normalized": "BLACK DUCK SOFTWARE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "BLACK DUCK SOFTWARE",
      "legal_names": [
        "Black Duck Software, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 15,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BURLINGTON"
      ]
    },
    {
      "company": "Blackbird Health",
      "normalized": "BLACKBIRD HEALTH",
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
      "company": "Blank Street",
      "normalized": "BLANK STREET",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BLANK STREET",
      "legal_names": [
        "BLANK STREET INC",
        "Blank Street Inc."
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "BROOKLYN"
      ]
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
      "company": "Blink Health",
      "normalized": "BLINK HEALTH",
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
      "company": "Blockchain.com",
      "normalized": "BLOCKCHAIN COM",
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
      "company": "Bloomreach",
      "normalized": "BLOOMREACH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BLOOMREACH",
      "legal_names": [
        "BLOOMREACH INC",
        "BloomReach, Inc."
      ],
      "approvals": 24,
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
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Blue Forest",
      "normalized": "BLUE FOREST",
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
      "company": "Bond Vet",
      "normalized": "BOND VET",
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
      "company": "Boomi",
      "normalized": "BOOMI",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "BOOMI",
      "legal_names": [
        "BOOMI INC",
        "BOOMI LP"
      ],
      "approvals": 123,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "PA",
        "TX"
      ],
      "filing_cities": [
        "CHESTERBROOK",
        "ROUND ROCK",
        "WAYNE"
      ]
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
      "company": "Brainlabs",
      "normalized": "BRAINLABS",
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
      "company": "BridgeBio Pharma",
      "normalized": "BRIDGEBIO PHARMA",
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
      "company": "Brilliant Earth",
      "normalized": "BRILLIANT EARTH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BRILLIANT EARTH",
      "legal_names": [
        "BRILLIANT EARTH LLC",
        "Brilliant Earth, LLC"
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
      "company": "BRPH",
      "normalized": "BRPH",
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
      "company": "Brunswick Group",
      "normalized": "BRUNSWICK GROUP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "BRUNSWICK GROUP",
      "legal_names": [
        "BRUNSWICK GROUP LLC",
        "Brunswick Group LLC"
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
      "company": "Buckner International",
      "normalized": "BUCKNER INTERNATIONAL",
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
      "company": "Bundl",
      "normalized": "BUNDL",
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
      "company": "Burson",
      "normalized": "BURSON",
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
      "company": "C3 AI",
      "normalized": "C3 AI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "C3 AI",
      "legal_names": [
        "C3 AI INC",
        "C3.ai, Inc."
      ],
      "approvals": 110,
      "denials": 4,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 106,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "C6 Bank",
      "normalized": "C6 BANK",
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
      "company": "Cabify",
      "normalized": "CABIFY",
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
      "company": "CannonDesign",
      "normalized": "CANNONDESIGN",
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
      "company": "Canonical",
      "normalized": "CANONICAL",
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
      "company": "Capco",
      "normalized": "CAPCO",
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
      "company": "Capgemini Invent",
      "normalized": "CAPGEMINI INVENT",
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
      "company": "Captivation Software",
      "normalized": "CAPTIVATION SOFTWARE",
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
      "company": "CaptiveAire",
      "normalized": "CAPTIVEAIRE",
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
      "company": "Career Team",
      "normalized": "CAREER TEAM",
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
      "company": "Careers at Eucalyptus",
      "normalized": "CAREERS AT EUCALYPTUS",
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
      "company": "Careers at KKR",
      "normalized": "CAREERS AT KKR",
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
      "company": "Careers at Tide",
      "normalized": "CAREERS AT TIDE",
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
      "company": "CarGurus",
      "normalized": "CARGURUS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CARGURUS",
      "legal_names": [
        "CARGURUS INC",
        "CarGurus, Inc."
      ],
      "approvals": 78,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 37,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON",
        "CAMBRIDGE"
      ]
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
      "company": "Carvana",
      "normalized": "CARVANA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CARVANA",
      "legal_names": [
        "CARVANA LLC",
        "Carvana, LLC"
      ],
      "approvals": 131,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 44,
      "filing_states": [
        "AZ"
      ],
      "filing_cities": [
        "TEMPE"
      ]
    },
    {
      "company": "Catawiki",
      "normalized": "CATAWIKI",
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
      "company": "Cato Networks",
      "normalized": "CATO NETWORKS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "CATO NETWORKS",
      "legal_names": [
        "Cato Networks Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN JOSE"
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
      "company": "Caylent",
      "normalized": "CAYLENT",
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
      "company": "cbs Corporate Business Solutions",
      "normalized": "CBS CORPORATE BUSINESS SOLUTIONS",
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
      "company": "Celonis",
      "normalized": "CELONIS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CELONIS",
      "legal_names": [
        "CELONIS INC",
        "Celonis, Inc."
      ],
      "approvals": 17,
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
      "company": "Center for a New American Security",
      "normalized": "CENTER FOR A NEW AMERICAN SECURITY",
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
      "company": "Centria Autism",
      "normalized": "CENTRIA AUTISM",
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
      "company": "Centria Healthcare",
      "normalized": "CENTRIA HEALTHCARE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CENTRIA HEALTHCARE",
      "legal_names": [
        "CENTRIA HEALTHCARE LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "MI"
      ],
      "filing_cities": [
        "FARMINGTON HILLS"
      ]
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
      "company": "CFO Insights",
      "normalized": "CFO INSIGHTS",
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
      "company": "CHAOS Industries",
      "normalized": "CHAOS INDUSTRIES",
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
      "company": "ChargerHelp",
      "normalized": "CHARGERHELP",
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
      "company": "Charles River Associates",
      "normalized": "CHARLES RIVER ASSOCIATES",
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
      "company": "Charlie Health",
      "normalized": "CHARLIE HEALTH",
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
      "company": "Chicago Retail Consulting",
      "normalized": "CHICAGO RETAIL CONSULTING",
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
      "company": "Chowbus",
      "normalized": "CHOWBUS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CHOWBUS",
      "legal_names": [
        "CHOWBUS INC",
        "Chowbus, Inc."
      ],
      "approvals": 19,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
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
      "company": "Cision",
      "normalized": "CISION",
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
      "company": "Clara",
      "normalized": "CLARA",
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
      "company": "ClassPass",
      "normalized": "CLASSPASS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CLASSPASS",
      "legal_names": [
        "CLASSPASS INC"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "MT"
      ],
      "filing_cities": [
        "MISSOULA"
      ]
    },
    {
      "company": "Clearway Energy",
      "normalized": "CLEARWAY ENERGY",
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
      "company": "Clever Real Estate",
      "normalized": "CLEVER REAL ESTATE",
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
      "company": "ClinChoice",
      "normalized": "CLINCHOICE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CLINCHOICE",
      "legal_names": [
        "CLINCHOICE INC",
        "ClinChoice Inc."
      ],
      "approvals": 59,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 19,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "FORT WASHINGTON",
        "HORSHAM"
      ]
    },
    {
      "company": "Cloudbeds",
      "normalized": "CLOUDBEDS",
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
      "company": "Clutch Technologies Inc.",
      "normalized": "CLUTCH TECHNOLOGIES",
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
      "company": "Code and Theory",
      "normalized": "CODE AND THEORY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CODE AND THEORY",
      "legal_names": [
        "CODE AND THEORY LLC",
        "Code and Theory LLC"
      ],
      "approvals": 5,
      "denials": 0,
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
      "company": "Cohere Health",
      "normalized": "COHERE HEALTH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "COHERE HEALTH",
      "legal_names": [
        "COHERE HEALTH INC",
        "Cohere Health, Inc."
      ],
      "approvals": 18,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 26,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON"
      ]
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
      "company": "Commvault",
      "normalized": "COMMVAULT",
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
      "company": "Compass",
      "normalized": "COMPASS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "COMPASS",
      "legal_names": [
        "COMPASS INC",
        "Compass, Inc."
      ],
      "approvals": 89,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "IL",
        "NY"
      ],
      "filing_cities": [
        "ARLINGTON HEIGHTS",
        "ARLINGTON HTS",
        "NEW YORK",
        "NEW YORK CITY"
      ]
    },
    {
      "company": "Compass Health Center",
      "normalized": "COMPASS HEALTH CENTER",
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
      "company": "Compass Pathways",
      "normalized": "COMPASS PATHWAYS",
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
      "company": "Comstock",
      "normalized": "COMSTOCK",
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
      "company": "Conga",
      "normalized": "CONGA",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "CONGA",
      "legal_names": [
        "Conga Corporation"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 12,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "BROOMFIELD"
      ]
    },
    {
      "company": "‎ConnectWise",
      "normalized": "CONNECTWISE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CONNECTWISE",
      "legal_names": [
        "CONNECTWISE LLC",
        "ConnectWise LLC"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "FL"
      ],
      "filing_cities": [
        "TAMPA"
      ]
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
      "company": "Construction Resources",
      "normalized": "CONSTRUCTION RESOURCES",
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
      "company": "ConvenientMD",
      "normalized": "CONVENIENTMD",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "CONVENIENTMD",
      "legal_names": [
        "ConvenientMD, LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "NH"
      ],
      "filing_cities": [
        "PORTSMOUTH"
      ]
    },
    {
      "company": "Convera",
      "normalized": "CONVERA",
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
      "company": "CookUnity",
      "normalized": "COOKUNITY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "COOKUNITY",
      "legal_names": [
        "COOKUNITY INC",
        "COOKUNITY INC DBA COOKUNITY",
        "COOKUNITY INC.",
        "CookUnity Inc",
        "CookUnity Inc.",
        "CookUnity LLC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021,
        2023
      ],
      "lca_certifications": 6,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "BROOKLYN",
        "NEW YORK"
      ]
    },
    {
      "company": "Corcept Therapeutics",
      "normalized": "CORCEPT THERAPEUTICS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CORCEPT THERAPEUTICS",
      "legal_names": [
        "CORCEPT THERAPEUTICS INC",
        "CORCEPT THERAPEUTICS, INC.",
        "Corcept Therapeutics Incorporated",
        "Corcept Therapeutics, Inc"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 5,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MENLO PARK",
        "REDWOOD CITY"
      ]
    },
    {
      "company": "Core One",
      "normalized": "CORE ONE",
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
      "company": "CoreWeave",
      "normalized": "COREWEAVE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "COREWEAVE",
      "legal_names": [
        "CoreWeave, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 28,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "LIVINGSTON"
      ]
    },
    {
      "company": "CoreWeave Europe",
      "normalized": "COREWEAVE EUROPE",
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
      "company": "Cortica",
      "normalized": "CORTICA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CORTICA",
      "legal_names": [
        "CORTICA INC",
        "Cortica, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
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
      "company": "Cortica - Neurodevelopmental",
      "normalized": "CORTICA NEURODEVELOPMENTAL",
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
      "company": "Cottingham & Butler",
      "normalized": "COTTINGHAM AND BUTLER",
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
      "company": "Coupang",
      "normalized": "COUPANG",
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
      "company": "CPI Security",
      "normalized": "CPI SECURITY",
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
      "company": "Creative Clicks",
      "normalized": "CREATIVE CLICKS",
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
      "company": "Cresco Labs",
      "normalized": "CRESCO LABS",
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
      "company": "Crestwood Behavioral Health",
      "normalized": "CRESTWOOD BEHAVIORAL HEALTH",
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
      "company": "Cribl",
      "normalized": "CRIBL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "CRIBL",
      "legal_names": [
        "CRIBL INC",
        "Cribl, Inc."
      ],
      "approvals": 16,
      "denials": 1,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 15,
      "filing_states": [
        "CA",
        "TX"
      ],
      "filing_cities": [
        "HOUSTON",
        "SAN FRANCISCO"
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
      "company": "Crisp Recruit",
      "normalized": "CRISP RECRUIT",
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
      "company": "Crowdsec",
      "normalized": "CROWDSEC",
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
      "company": "Curaleaf",
      "normalized": "CURALEAF",
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
      "company": "CVX Ventures",
      "normalized": "CVX VENTURES",
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
      "company": "Dark Wolf Solutions",
      "normalized": "DARK WOLF SOLUTIONS",
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
      "company": "Datavant",
      "normalized": "DATAVANT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DATAVANT",
      "legal_names": [
        "DATAVANT INC",
        "DATAVANT, INC.",
        "Datavant, LLC"
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
        "CA",
        "GA",
        "NY"
      ],
      "filing_cities": [
        "ATLANTA",
        "NEW YORK",
        "SAN FRANCISCO"
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
      "company": "Decima International",
      "normalized": "DECIMA INTERNATIONAL",
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
      "company": "Defense Unicorns",
      "normalized": "DEFENSE UNICORNS",
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
      "company": "Dental365",
      "normalized": "DENTAL365",
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
      "company": "DEPT®",
      "normalized": "DEPT",
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
      "company": "Despegar",
      "normalized": "DESPEGAR",
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
      "company": "Dexis",
      "normalized": "DEXIS",
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
      "company": "DH Pace",
      "normalized": "DH PACE",
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
      "company": "Dialpad",
      "normalized": "DIALPAD",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DIALPAD",
      "legal_names": [
        "DIALPAD INC",
        "Dialpad, Inc."
      ],
      "approvals": 15,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA",
        "TX"
      ],
      "filing_cities": [
        "AUSTIN",
        "SAN RAMON"
      ]
    },
    {
      "company": "Diana Health",
      "normalized": "DIANA HEALTH",
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
      "company": "DIG INN Chefs-In-Training",
      "normalized": "DIG INN CHEFS IN TRAINING",
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
      "company": "DIG INN Restaurant Teams",
      "normalized": "DIG INN RESTAURANT TEAMS",
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
      "company": "DigiCert",
      "normalized": "DIGICERT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DIGICERT",
      "legal_names": [
        "DIGICERT INC",
        "DigiCert Inc.",
        "DigiCert, Inc."
      ],
      "approvals": 26,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 12,
      "filing_states": [
        "UT"
      ],
      "filing_cities": [
        "LEHI"
      ]
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
      "company": "DigitalOcean",
      "normalized": "DIGITALOCEAN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DIGITALOCEAN",
      "legal_names": [
        "DIGITALOCEAN LLC",
        "DigitalOcean, LLC"
      ],
      "approvals": 41,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 29,
      "filing_states": [
        "CO",
        "NY"
      ],
      "filing_cities": [
        "BROOMFIELD",
        "NEW YORK"
      ]
    },
    {
      "company": "Diligent Corporation",
      "normalized": "DILIGENT",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "DILIGENT",
      "legal_names": [
        "DILIGENT CORPORATION"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
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
      "company": "Divergent",
      "normalized": "DIVERGENT",
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
      "company": "DLR Group",
      "normalized": "DLR GROUP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DLR GROUP",
      "legal_names": [
        "DLR GROUP INC",
        "DLR Group, Inc."
      ],
      "approvals": 17,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 10,
      "filing_states": [
        "NE"
      ],
      "filing_cities": [
        "OMAHA"
      ]
    },
    {
      "company": "Doctolib",
      "normalized": "DOCTOLIB",
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
      "company": "DoiT",
      "normalized": "DOIT",
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
      "company": "DoorDash USA",
      "normalized": "DOORDASH USA",
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
      "company": "Dragos",
      "normalized": "DRAGOS",
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
      "company": "dunnhumby",
      "normalized": "DUNNHUMBY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DUNNHUMBY",
      "legal_names": [
        "DUNNHUMBY INC",
        "dunnhumby, Inc."
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 13,
      "filing_states": [
        "OH"
      ],
      "filing_cities": [
        "CINCINNATI"
      ]
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
      "company": "Dyne Therapeutics",
      "normalized": "DYNE THERAPEUTICS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "DYNE THERAPEUTICS",
      "legal_names": [
        "DYNE THERAPEUTICS INC",
        "Dyne Therapeutics, Inc."
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 6,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "WALTHAM"
      ]
    },
    {
      "company": "Eating Recovery Center",
      "normalized": "EATING RECOVERY CENTER",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "EATING RECOVERY CENTER",
      "legal_names": [
        "EATING RECOVERY CENTER, LLC",
        "Eating Recovery Center, LLC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 3,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "DENVER"
      ]
    },
    {
      "company": "Ebury",
      "normalized": "EBURY",
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
      "company": "Effective School Solutions",
      "normalized": "EFFECTIVE SCHOOL SOLUTIONS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "EFFECTIVE SCHOOL SOLUTIONS",
      "legal_names": [
        "Effective School Solutions LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "NEW PROVIDENCE"
      ]
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
      "company": "Electrosoft",
      "normalized": "ELECTROSOFT",
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
      "company": "Eliot Community Human Services",
      "normalized": "ELIOT COMMUNITY HUMAN SERVICES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ELIOT COMMUNITY HUMAN SERVICES",
      "legal_names": [
        "ELIOT COMMUNITY HUMAN SERVICES INC",
        "Eliot Community Human Services, Inc."
      ],
      "approvals": 14,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "LEXINGTON"
      ]
    },
    {
      "company": "Elite Dental Partners",
      "normalized": "ELITE DENTAL PARTNERS",
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
      "company": "Encora",
      "normalized": "ENCORA",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "ENCORA",
      "legal_names": [
        "Encora, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON"
      ]
    },
    {
      "company": "Engine",
      "normalized": "ENGINE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ENGINE",
      "legal_names": [
        "ENGINE LLC"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "PITTSBURGH"
      ]
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
      "company": "Ennoble Care",
      "normalized": "ENNOBLE CARE",
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
      "company": "Enpal",
      "normalized": "ENPAL",
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
      "company": "ENSCO, Inc.",
      "normalized": "ENSCO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ENSCO",
      "legal_names": [
        "ENSCO INC",
        "ENSCO INCORPORATED",
        "ENSCO, Inc"
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "TX",
        "VA"
      ],
      "filing_cities": [
        "HOUSTON",
        "SPRINGFIELD",
        "VIENNA"
      ]
    },
    {
      "company": "Ensono",
      "normalized": "ENSONO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ENSONO",
      "legal_names": [
        "ENSONO INC",
        "ENSONO LLC",
        "ENSONO LP",
        "Ensono, Inc.",
        "Ensono, LLC"
      ],
      "approvals": 27,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 27,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "DOWNERS GROVE"
      ]
    },
    {
      "company": "Envipco",
      "normalized": "ENVIPCO",
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
      "company": "Envisio",
      "normalized": "ENVISIO",
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
      "company": "EOS",
      "normalized": "EOS",
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
      "company": "EPIC Brokers",
      "normalized": "EPIC BROKERS",
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
      "company": "ePlus Technology, inc.",
      "normalized": "EPLUS TECHNOLOGY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "EPLUS TECHNOLOGY",
      "legal_names": [
        "EPLUS TECHNOLOGY INC",
        "ePlus Technology, inc."
      ],
      "approvals": 13,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 5,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "HERNDON"
      ]
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
      "company": "EquipmentShare",
      "normalized": "EQUIPMENTSHARE",
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
      "company": "Ernesta",
      "normalized": "ERNESTA",
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
      "company": "Esri",
      "normalized": "ESRI",
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
      "company": "Ethos Life",
      "normalized": "ETHOS LIFE",
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
      "company": "everdrop",
      "normalized": "EVERDROP",
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
      "company": "Evergreen Residential Holdings, LLC",
      "normalized": "EVERGREEN RESIDENTIAL HOLDINGS",
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
      "company": "Evolve Physical Therapy",
      "normalized": "EVOLVE PHYSICAL THERAPY",
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
      "company": "Exadel",
      "normalized": "EXADEL",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "EXADEL",
      "legal_names": [
        "Exadel, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "WALNUT CREEK"
      ]
    },
    {
      "company": "Exadel Inc (Website)",
      "normalized": "EXADEL INC WEBSITE",
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
      "company": "Exiger",
      "normalized": "EXIGER",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "EXIGER",
      "legal_names": [
        "EXIGER",
        "EXIGER LLC"
      ],
      "approvals": 5,
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
      "company": "fairlife",
      "normalized": "FAIRLIFE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FAIRLIFE",
      "legal_names": [
        "FAIRLIFE LLC",
        "fairlife, LLC"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 7,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "Fairstead ESC LLC",
      "normalized": "FAIRSTEAD ESC",
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
      "company": "Family of Kidz",
      "normalized": "FAMILY OF KIDZ",
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
      "company": "Famly",
      "normalized": "FAMLY",
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
      "company": "Fanatics Betting & Gaming",
      "normalized": "FANATICS BETTING AND GAMING",
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
      "company": "Fanatics Collectibles",
      "normalized": "FANATICS COLLECTIBLES",
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
      "company": "Faraday Future",
      "normalized": "FARADAY FUTURE",
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
      "company": "Fetch",
      "normalized": "FETCH",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "FETCH",
      "legal_names": [
        "Fetch, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "FeverUp",
      "normalized": "FEVERUP",
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
      "company": "Fictiv",
      "normalized": "FICTIV",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FICTIV",
      "legal_names": [
        "FICTIV INC",
        "Fictiv, Inc."
      ],
      "approvals": 15,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 5,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "FREMONT",
        "OAKLAND",
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
      "company": "Fin",
      "normalized": "FIN",
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
      "company": "Financial Times",
      "normalized": "FINANCIAL TIMES",
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
      "company": "First Global Management Services, Inc.",
      "normalized": "FIRST GLOBAL MANAGEMENT SERVICES",
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
      "company": "FirstMind",
      "normalized": "FIRSTMIND",
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
      "company": "Five9",
      "normalized": "FIVE9",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FIVE9",
      "legal_names": [
        "FIVE9 INC",
        "Five9, Inc."
      ],
      "approvals": 40,
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
        "SAN RAMON"
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
      "company": "Flagship Pioneering, Inc.",
      "normalized": "FLAGSHIP PIONEERING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FLAGSHIP PIONEERING",
      "legal_names": [
        "FLAGSHIP PIONEERING INC",
        "Flagship Pioneering, Inc."
      ],
      "approvals": 7,
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
        "CAMBRIDGE"
      ]
    },
    {
      "company": "Flex",
      "normalized": "FLEX",
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
      "company": "Fora",
      "normalized": "FORA",
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
      "company": "Forgen",
      "normalized": "FORGEN",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FORGEN",
      "legal_names": [
        "FORGEN LLC",
        "Forgen, LLC"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA",
        "CO"
      ],
      "filing_cities": [
        "CENTENNIAL",
        "ROCKLIN"
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
      "company": "Foundation Risk Partners",
      "normalized": "FOUNDATION RISK PARTNERS",
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
      "company": "Framestore",
      "normalized": "FRAMESTORE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "FRAMESTORE",
      "legal_names": [
        "FRAMESTORE INC",
        "Framestore, Inc",
        "Framestore, Inc."
      ],
      "approvals": 10,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 9,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Freeday",
      "normalized": "FREEDAY",
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
      "company": "Freedom Technology Solutions Group",
      "normalized": "FREEDOM TECHNOLOGY SOLUTIONS GROUP",
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
      "company": "Freeform",
      "normalized": "FREEFORM",
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
      "company": "Freenow by Lyft",
      "normalized": "FREENOW BY LYFT",
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
      "company": "Fundraise Up",
      "normalized": "FUNDRAISE UP",
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
      "company": "Galaxy",
      "normalized": "GALAXY",
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
      "company": "Garner Health",
      "normalized": "GARNER HEALTH",
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
      "company": "Gatik AI",
      "normalized": "GATIK AI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GATIK AI",
      "legal_names": [
        "GATIK AI INC",
        "Gatik AI Inc."
      ],
      "approvals": 14,
      "denials": 0,
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
        "MOUNTAIN VIEW",
        "PALO ALTO"
      ]
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
      "company": "General Matter",
      "normalized": "GENERAL MATTER",
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
      "company": "Genius Sports",
      "normalized": "GENIUS SPORTS",
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
      "company": "Genius Sports Statistician Network",
      "normalized": "GENIUS SPORTS STATISTICIAN NETWORK",
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
      "company": "GenScript/ProBio",
      "normalized": "GENSCRIPT PROBIO",
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
      "company": "Getty Advance",
      "normalized": "GETTY ADVANCE",
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
      "company": "GFiber",
      "normalized": "GFIBER",
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
      "company": "Giga Energy",
      "normalized": "GIGA ENERGY",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "GIGA ENERGY",
      "legal_names": [
        "Giga Energy Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "BUNA"
      ]
    },
    {
      "company": "Gigs",
      "normalized": "GIGS",
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
      "company": "Glance",
      "normalized": "GLANCE",
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
      "company": "Glean",
      "normalized": "GLEAN",
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
      "company": "GLG",
      "normalized": "GLG",
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
      "company": "GoFundMe",
      "normalized": "GOFUNDME",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GOFUNDME",
      "legal_names": [
        "GOFUNDME INC",
        "GOFUNDME, INC.",
        "GoFundMe, Inc."
      ],
      "approvals": 25,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 15,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY",
        "SAN DIEGO"
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
      "company": "gorjana",
      "normalized": "GORJANA",
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
      "company": "Gotion, Inc.",
      "normalized": "GOTION",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GOTION",
      "legal_names": [
        "GOTION INC",
        "Gotion, Inc."
      ],
      "approvals": 21,
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
        "FREMONT"
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
      "company": "Green Thumb",
      "normalized": "GREEN THUMB",
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
      "company": "GreenFlux",
      "normalized": "GREENFLUX",
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
      "company": "Greenpoint Technologies",
      "normalized": "GREENPOINT TECHNOLOGIES",
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
      "company": "Growe Talents",
      "normalized": "GROWE TALENTS",
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
      "company": "GRVTY",
      "normalized": "GRVTY",
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
      "company": "Guidepoint",
      "normalized": "GUIDEPOINT",
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
      "company": "GuidePoint Security",
      "normalized": "GUIDEPOINT SECURITY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "GUIDEPOINT SECURITY",
      "legal_names": [
        "GUIDEPOINT SECURITY LLC",
        "GuidePoint Security, LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 8,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "HERNDON",
        "RESTON"
      ]
    },
    {
      "company": "Guidepost Montessori",
      "normalized": "GUIDEPOST MONTESSORI",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "GUIDEPOST A LLC DBA GUIDEPOST MONTESSORI",
      "legal_names": [
        "GUIDEPOST A LLC DBA GUIDEPOST MONTESSORI"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "LAKE FOREST"
      ]
    },
    {
      "company": "Guild Garage Group",
      "normalized": "GUILD GARAGE GROUP",
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
      "company": "Harbinger Motors Inc.",
      "normalized": "HARBINGER MOTORS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "HARBINGER MOTORS",
      "legal_names": [
        "Harbinger Motors Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 33,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "GARDEN GROVE"
      ]
    },
    {
      "company": "Harness",
      "normalized": "HARNESS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HARNESS",
      "legal_names": [
        "HARNESS INC",
        "Harness Inc.",
        "Harness, Inc."
      ],
      "approvals": 35,
      "denials": 1,
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
      "company": "Hasbro",
      "normalized": "HASBRO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HASBRO",
      "legal_names": [
        "HASBRO INC",
        "Hasbro, Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 2,
      "filing_states": [
        "RI"
      ],
      "filing_cities": [
        "PAWTUCKET"
      ]
    },
    {
      "company": "Hawthorne Residential Partners",
      "normalized": "HAWTHORNE RESIDENTIAL PARTNERS",
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
      "company": "Headlands Research",
      "normalized": "HEADLANDS RESEARCH",
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
      "company": "Heart + Paw",
      "normalized": "HEART PAW",
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
      "company": "Heartflow",
      "normalized": "HEARTFLOW",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HEARTFLOW",
      "legal_names": [
        "HEARTFLOW INC",
        "HEARTFLOW, INC."
      ],
      "approvals": 17,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 5,
      "filing_states": [
        "CA",
        "TX"
      ],
      "filing_cities": [
        "AUSTIN",
        "MOUNTAIN VIEW"
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
      "company": "Helping Hands Family",
      "normalized": "HELPING HANDS FAMILY",
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
      "company": "Helsing",
      "normalized": "HELSING",
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
      "company": "Highwire",
      "normalized": "HIGHWIRE",
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
      "company": "Hillel International",
      "normalized": "HILLEL INTERNATIONAL",
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
      "company": "Holder Construction",
      "normalized": "HOLDER CONSTRUCTION",
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
      "company": "Holistic Industries",
      "normalized": "HOLISTIC INDUSTRIES",
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
      "company": "Horace Mann - Agent Opportunities",
      "normalized": "HORACE MANN AGENT OPPORTUNITIES",
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
      "company": "House Buyers of America",
      "normalized": "HOUSE BUYERS OF AMERICA",
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
      "company": "HP Hood",
      "normalized": "HP HOOD",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HP HOOD",
      "legal_names": [
        "HP HOOD LLC",
        "HP Hood LLC"
      ],
      "approvals": 16,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 10,
      "filing_states": [
        "MA",
        "NY"
      ],
      "filing_cities": [
        "FAYETTEVILLE",
        "LYNNFIELD",
        "ONEIDA",
        "VERNON"
      ]
    },
    {
      "company": "HRtechX",
      "normalized": "HRTECHX",
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
      "company": "Hudson Manpower",
      "normalized": "HUDSON MANPOWER",
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
      "company": "Human Agency",
      "normalized": "HUMAN AGENCY",
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
      "company": "Human Interest",
      "normalized": "HUMAN INTEREST",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "HUMAN INTEREST",
      "legal_names": [
        "HUMAN INTEREST INC",
        "Human Interest, Inc."
      ],
      "approvals": 8,
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
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Hut 8",
      "normalized": "HUT 8",
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
      "company": "Hydrite",
      "normalized": "HYDRITE",
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
      "company": "i360technologies, Inc.",
      "normalized": "I360TECHNOLOGIES",
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
      "company": "Ibexa",
      "normalized": "IBEXA",
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
      "company": "iCapital",
      "normalized": "ICAPITAL",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "INSTITUTIONAL CAPITAL NETWORK INC DBA ICAPITAL",
      "legal_names": [
        "INSTITUTIONAL CAPITAL NETWORK INC DBA ICAPITAL"
      ],
      "approvals": 14,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK",
        "NEW YORK CITY"
      ]
    },
    {
      "company": "ICON",
      "normalized": "ICON",
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
      "company": "ID.me",
      "normalized": "ID ME",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "ID ME",
      "legal_names": [
        "ID.me, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 12,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "MCLEAN"
      ]
    },
    {
      "company": "IEQ Capital",
      "normalized": "IEQ CAPITAL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "IEQ CAPITAL",
      "legal_names": [
        "IEQ CAPITAL LLC",
        "IEQ Capital, LLC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "FOSTER CITY",
        "SAN MATEO"
      ]
    },
    {
      "company": "iFood",
      "normalized": "IFOOD",
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
      "company": "IMA Financial Group",
      "normalized": "IMA FINANCIAL GROUP",
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
      "company": "impact.com",
      "normalized": "IMPACT COM",
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
      "company": "Industrial Electric Manufacturing",
      "normalized": "INDUSTRIAL ELECTRIC MANUFACTURING",
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
      "company": "INFUSE",
      "normalized": "INFUSE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "INFUSE",
      "legal_names": [
        "INFUSE, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 6,
      "filing_states": [
        "FL"
      ],
      "filing_cities": [
        "BOCA RATON"
      ]
    },
    {
      "company": "InHome Therapy",
      "normalized": "INHOME THERAPY",
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
      "company": "InMobi",
      "normalized": "INMOBI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "INMOBI",
      "legal_names": [
        "INMOBI INC",
        "InMobi, Inc."
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
        "SAN FRANCISCO",
        "SAN MATEO"
      ]
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
      "company": "Inovalon",
      "normalized": "INOVALON",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "INOVALON",
      "legal_names": [
        "INOVALON INC",
        "Inovalon, Inc."
      ],
      "approvals": 215,
      "denials": 8,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 62,
      "filing_states": [
        "MD"
      ],
      "filing_cities": [
        "BOWIE"
      ]
    },
    {
      "company": "Inspiring Lives Today",
      "normalized": "INSPIRING LIVES TODAY",
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
      "company": "Integrity Rehab Group",
      "normalized": "INTEGRITY REHAB GROUP",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "INTEGRITY REHAB GROUP",
      "legal_names": [
        "INTEGRITY REHAB GROUP INC",
        "INTEGRITY REHAB GROUP LLC"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "TN"
      ],
      "filing_cities": [
        "CHATTANOOGA"
      ]
    },
    {
      "company": "Inter",
      "normalized": "INTER",
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
      "company": "InterSystems",
      "normalized": "INTERSYSTEMS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "INTERSYSTEMS",
      "legal_names": [
        "INTERSYSTEMS CORPORATION",
        "InterSystems Corporation"
      ],
      "approvals": 54,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 62,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON",
        "CAMBRIDGE"
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
      "company": "Inversion",
      "normalized": "INVERSION",
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
      "company": "Isar Aerospace SE",
      "normalized": "ISAR AEROSPACE SE",
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
      "company": "Iterative Health",
      "normalized": "ITERATIVE HEALTH",
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
      "company": "Ivalua",
      "normalized": "IVALUA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "IVALUA",
      "legal_names": [
        "IVALUA",
        "IVALUA INC",
        "Ivalua, Inc."
      ],
      "approvals": 53,
      "denials": 3,
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
        "REDWOOD CITY"
      ]
    },
    {
      "company": "IVX Health",
      "normalized": "IVX HEALTH",
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
      "company": "IXL Learning",
      "normalized": "IXL LEARNING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "IXL LEARNING",
      "legal_names": [
        "IXL LEARNING INC",
        "IXL Learning, Inc."
      ],
      "approvals": 35,
      "denials": 1,
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
        "SAN MATEO"
      ]
    },
    {
      "company": "J&J Snack Foods",
      "normalized": "J AND J SNACK FOODS",
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
      "company": "JD Sports",
      "normalized": "JD SPORTS",
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
      "company": "Jensen Hughes",
      "normalized": "JENSEN HUGHES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "JENSEN HUGHES",
      "legal_names": [
        "JENSEN HUGHES INC",
        "Jensen Hughes, Inc."
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 7,
      "filing_states": [
        "MD"
      ],
      "filing_cities": [
        "BALTIMORE",
        "COLUMBIA",
        "HALETHORPE"
      ]
    },
    {
      "company": "JetBrains",
      "normalized": "JETBRAINS",
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
      "company": "Joya",
      "normalized": "JOYA",
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
      "company": "JRM Construction Management, LLC",
      "normalized": "JRM CONSTRUCTION MANAGEMENT",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "JRM CONSTRUCTION MANAGEMENT",
      "legal_names": [
        "JRM CONSTRUCTION MANAGEMENT LLC"
      ],
      "approvals": 2,
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
      "company": "Jukebox Health",
      "normalized": "JUKEBOX HEALTH",
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
      "company": "JWay Group",
      "normalized": "JWAY GROUP",
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
      "company": "K2 Space",
      "normalized": "K2 SPACE",
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
      "company": "Kaseya Careers",
      "normalized": "KASEYA CAREERS",
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
      "company": "KBRA",
      "normalized": "KBRA",
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
      "company": "Keeper Security",
      "normalized": "KEEPER SECURITY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "CALLPOD INC DBA KEEPER SECURITY",
      "legal_names": [
        "CALLPOD INC DBA KEEPER SECURITY INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "Kestra Medical Technologies Inc.",
      "normalized": "KESTRA MEDICAL TECHNOLOGIES",
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
      "company": "Kinder's",
      "normalized": "KINDER S",
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
      "company": "KnowBe4",
      "normalized": "KNOWBE4",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "KNOWBE4",
      "legal_names": [
        "KNOWBE4 INC",
        "KnowBe4, Inc."
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "FL"
      ],
      "filing_cities": [
        "CLEARWATER"
      ]
    },
    {
      "company": "Kodiak",
      "normalized": "KODIAK",
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
      "company": "KRAFTON",
      "normalized": "KRAFTON",
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
      "company": "Kyo",
      "normalized": "KYO",
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
      "company": "La Senza",
      "normalized": "LA SENZA",
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
      "company": "LA28 (Web)",
      "normalized": "LA28 WEB",
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
      "company": "Lakefield Veterinary Group",
      "normalized": "LAKEFIELD VETERINARY GROUP",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "LAKEFIELD VETERINARY GROUP",
      "legal_names": [
        "LAKEFIELD VETERINARY GROUP INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "WA"
      ],
      "filing_cities": [
        "KENT"
      ]
    },
    {
      "company": "Landor",
      "normalized": "LANDOR",
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
      "company": "Latitude AI",
      "normalized": "LATITUDE AI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "LATITUDE AI",
      "legal_names": [
        "LATITUDE AI LLC",
        "Latitude AI, LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 42,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "PITTSBURGH"
      ]
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
      "company": "Launch Potato",
      "normalized": "LAUNCH POTATO",
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
      "company": "Ledger",
      "normalized": "LEDGER",
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
      "company": "Legend Biotech US",
      "normalized": "LEGEND BIOTECH US",
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
      "company": "Levio",
      "normalized": "LEVIO",
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
      "company": "LG Electronics",
      "normalized": "LG ELECTRONICS",
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
      "company": "Life Skills Autism Academy",
      "normalized": "LIFE SKILLS AUTISM ACADEMY",
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
      "company": "Lighthouse",
      "normalized": "LIGHTHOUSE",
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
      "company": "Lightning AI",
      "normalized": "LIGHTNING AI",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "GRID AI INC DBA LIGHTNING AI",
      "legal_names": [
        "GRID AI INC DBA LIGHTNING AI"
      ],
      "approvals": 2,
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
      "company": "Lila Sciences",
      "normalized": "LILA SCIENCES",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "LILA SCIENCES",
      "legal_names": [
        "Lila Sciences, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 7,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "CAMBRIDGE"
      ]
    },
    {
      "company": "Lincoln Property Company",
      "normalized": "LINCOLN PROPERTY COMPANY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "LINCOLN PROPERTY COMPANY",
      "legal_names": [
        "LINCOLN PROPERTY COMPANY"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "ARLINGTON"
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
      "company": "Liquid Personnel",
      "normalized": "LIQUID PERSONNEL",
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
      "company": "Loenbro",
      "normalized": "LOENBRO",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "LOENBRO",
      "legal_names": [
        "Loenbro, LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "WESTMINSTER"
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
      "company": "LotusWorks",
      "normalized": "LOTUSWORKS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "LOTUS AUTOMATION USA INC DBA LOTUSWORKS",
      "legal_names": [
        "LOTUS AUTOMATION USA INC DBA LOTUSWORKS INC",
        "LotusWorks, Inc."
      ],
      "approvals": 0,
      "denials": 1,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "MEDFORD"
      ]
    },
    {
      "company": "Lovable",
      "normalized": "LOVABLE",
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
      "company": "LS3P",
      "normalized": "LS3P",
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
      "company": "Luminary Hospice",
      "normalized": "LUMINARY HOSPICE",
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
      "company": "Luminis Health",
      "normalized": "LUMINIS HEALTH",
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
      "company": "Lush Handmade Cosmetics",
      "normalized": "LUSH HANDMADE COSMETICS",
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
      "company": "LVT",
      "normalized": "LVT",
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
      "company": "M9 Solutions",
      "normalized": "M9 SOLUTIONS",
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
      "company": "Madison Reed",
      "normalized": "MADISON REED",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MADISON REED",
      "legal_names": [
        "MADISON REED INC"
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
      "company": "Major League Baseball",
      "normalized": "MAJOR LEAGUE BASEBALL",
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
      "company": "MAP",
      "normalized": "MAP",
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
      "company": "Marksman Security LLC",
      "normalized": "MARKSMAN SECURITY",
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
      "company": "May Mobility",
      "normalized": "MAY MOBILITY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MAY MOBILITY",
      "legal_names": [
        "MAY MOBILITY INC",
        "May Mobility, Inc."
      ],
      "approvals": 22,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "MI"
      ],
      "filing_cities": [
        "ANN ARBOR"
      ]
    },
    {
      "company": "McAdams",
      "normalized": "MCADAMS",
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
      "company": "McClure Oil Corporation",
      "normalized": "MCCLURE OIL",
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
      "company": "MedElite Group, LLC.",
      "normalized": "MEDELITE GROUP",
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
      "company": "Mejuri",
      "normalized": "MEJURI",
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
      "company": "Mercedes-Benz.io",
      "normalized": "MERCEDES BENZ IO",
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
      "company": "Mercer Advisors",
      "normalized": "MERCER ADVISORS",
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
      "company": "Meridial",
      "normalized": "MERIDIAL",
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
      "company": "Method Co.",
      "normalized": "METHOD",
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
      "company": "Metro Vein Centers",
      "normalized": "METRO VEIN CENTERS",
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
      "company": "Metropolis",
      "normalized": "METROPOLIS",
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
      "company": "MetroStar",
      "normalized": "METROSTAR",
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
      "company": "MG Properties",
      "normalized": "MG PROPERTIES",
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
      "company": "mindsquare AG",
      "normalized": "MINDSQUARE AG",
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
      "company": "Mineralys Therapeutics",
      "normalized": "MINERALYS THERAPEUTICS",
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
      "company": "MiQ Digital",
      "normalized": "MIQ DIGITAL",
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
      "company": "Mirum Pharmaceuticals",
      "normalized": "MIRUM PHARMACEUTICALS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MIRUM PHARMACEUTICALS",
      "legal_names": [
        "MIRUM PHARMACEUTICALS INC",
        "Mirum Pharmaceuticals, Inc."
      ],
      "approvals": 3,
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
        "FOSTER CITY"
      ]
    },
    {
      "company": "Misfits Market",
      "normalized": "MISFITS MARKET",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MISFITS MARKET",
      "legal_names": [
        "MISFITS MARKET INC"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "PENNSAUKEN",
        "RIVERSIDE"
      ]
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
      "company": "Modern Animal",
      "normalized": "MODERN ANIMAL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MODERN ANIMAL",
      "legal_names": [
        "MODERN ANIMAL INC",
        "Modern Animal, Inc."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "CULVER CITY",
        "LOS ANGELES"
      ]
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
      "company": "Mollie",
      "normalized": "MOLLIE",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "MOLLIE",
      "legal_names": [
        "Mollie LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "FL"
      ],
      "filing_cities": [
        "TAMPA"
      ]
    },
    {
      "company": "Moloco",
      "normalized": "MOLOCO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MOLOCO",
      "legal_names": [
        "MOLOCO INC",
        "Moloco, Inc."
      ],
      "approvals": 24,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 50,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
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
      "company": "Moniepoint",
      "normalized": "MONIEPOINT",
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
      "company": "Monks",
      "normalized": "MONKS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "DECODED ADVERTISING LLC D B A MONKS",
      "legal_names": [
        "Decoded Advertising, LLC. d/b/a .monks",
        "Firewood Marketing, Inc. d/b/a .Monks"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
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
      "company": "Mood Health",
      "normalized": "MOOD HEALTH",
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
      "company": "Morgan & Morgan, P.A.",
      "normalized": "MORGAN AND MORGAN P A",
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
      "company": "MrBeast",
      "normalized": "MRBEAST",
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
      "company": "MTC Care",
      "normalized": "MTC CARE",
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
      "company": "mthree Recruiting Portal",
      "normalized": "MTHREE RECRUITING PORTAL",
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
      "company": "Muon Space",
      "normalized": "MUON SPACE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "MUON SPACE",
      "legal_names": [
        "MUON SPACE INC",
        "Muon Space, Inc."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Musixmatch",
      "normalized": "MUSIXMATCH",
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
      "company": "Myriad360",
      "normalized": "MYRIAD360",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "MYRIAD360",
      "legal_names": [
        "Myriad360, LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "WEST DEPTFORD"
      ]
    },
    {
      "company": "N2 - All Jobs",
      "normalized": "N2 ALL JOBS",
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
      "company": "Naked Farmer Careers",
      "normalized": "NAKED FARMER CAREERS",
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
      "company": "National Life Insurance Company",
      "normalized": "NATIONAL LIFE INSURANCE COMPANY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NATIONAL LIFE INSURANCE COMPANY",
      "legal_names": [
        "NATIONAL LIFE INSURANCE COMPANY",
        "National Life Insurance Company"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 14,
      "filing_states": [
        "VT"
      ],
      "filing_cities": [
        "MONTPELIER"
      ]
    },
    {
      "company": "National Lutheran Communities & Services",
      "normalized": "NATIONAL LUTHERAN COMMUNITIES AND SERVICES",
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
      "company": "Nebius",
      "normalized": "NEBIUS",
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
      "company": "Neo4j",
      "normalized": "NEO4J",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NEO4J",
      "legal_names": [
        "NEO4J INC",
        "Neo4j, Inc."
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN MATEO"
      ]
    },
    {
      "company": "Neros Technologies",
      "normalized": "NEROS TECHNOLOGIES",
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
      "company": "Netskope",
      "normalized": "NETSKOPE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NETSKOPE",
      "legal_names": [
        "NETSKOPE INC",
        "Netskope, Inc."
      ],
      "approvals": 181,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 39,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SANTA CLARA"
      ]
    },
    {
      "company": "NeuraFlash, Part of Accenture",
      "normalized": "NEURAFLASH PART OF ACCENTURE",
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
      "company": "Neuralink",
      "normalized": "NEURALINK",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NEURALINK",
      "legal_names": [
        "NEURALINK CORP",
        "Neuralink Corp.",
        "Neuralink Corporation"
      ],
      "approvals": 17,
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
        "FREMONT"
      ]
    },
    {
      "company": "New Era Technology",
      "normalized": "NEW ERA TECHNOLOGY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NEW ERA TECHNOLOGY",
      "legal_names": [
        "NEW ERA TECHNOLOGY INC",
        "New Era Technology, Inc."
      ],
      "approvals": 29,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 17,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "WEST CHESTER"
      ]
    },
    {
      "company": "New Relic",
      "normalized": "NEW RELIC",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NEW RELIC",
      "legal_names": [
        "NEW RELIC INC",
        "New Relic, Inc."
      ],
      "approvals": 34,
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
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "NewRocket",
      "normalized": "NEWROCKET",
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
      "company": "Nex",
      "normalized": "NEX",
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
      "company": "NexHealth",
      "normalized": "NEXHEALTH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "NEXHEALTH",
      "legal_names": [
        "NEXHEALTH INC",
        "Nexhealth Inc."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA",
        "UT"
      ],
      "filing_cities": [
        "DRAPER",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "NICE",
      "normalized": "NICE",
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
      "company": "Ninja Van",
      "normalized": "NINJA VAN",
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
      "company": "North Point Technology",
      "normalized": "NORTH POINT TECHNOLOGY",
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
      "company": "Northpoint Recovery Holdings, LLC",
      "normalized": "NORTHPOINT RECOVERY HOLDINGS",
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
      "company": "Nourish",
      "normalized": "NOURISH",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "NOURISH",
      "legal_names": [
        "Nourish, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 2,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "AUSTIN"
      ]
    },
    {
      "company": "Nox Group",
      "normalized": "NOX GROUP",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "NOX GROUP",
      "legal_names": [
        "NOX Group, LLC"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "AZ"
      ],
      "filing_cities": [
        "PHOENIX"
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
      "company": "NuView Analytics",
      "normalized": "NUVIEW ANALYTICS",
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
      "company": "Ogilvy",
      "normalized": "OGILVY",
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
      "company": "Oklo",
      "normalized": "OKLO",
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
      "company": "OKX",
      "normalized": "OKX",
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
      "company": "Oldcastle BuildingEnvelope",
      "normalized": "OLDCASTLE BUILDINGENVELOPE",
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
      "company": "OLIVER Agency - APAC",
      "normalized": "OLIVER AGENCY APAC",
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
      "company": "Olsson",
      "normalized": "OLSSON",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OLSSON",
      "legal_names": [
        "OLSSON INC",
        "Olsson, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 11,
      "filing_states": [
        "NE"
      ],
      "filing_cities": [
        "LINCOLN"
      ]
    },
    {
      "company": "Olympus Property",
      "normalized": "OLYMPUS PROPERTY",
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
      "company": "Omnicom Media",
      "normalized": "OMNICOM MEDIA",
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
      "company": "On",
      "normalized": "ON",
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
      "company": "ON.energy",
      "normalized": "ON ENERGY",
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
      "company": "One Acre Fund",
      "normalized": "ONE ACRE FUND",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ONE ACRE FUND",
      "legal_names": [
        "ONE ACRE FUND"
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
        "BROOKLYN"
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
      "company": "OneTrust",
      "normalized": "ONETRUST",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "ONETRUST",
      "legal_names": [
        "ONETRUST LLC"
      ],
      "approvals": 181,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "GA"
      ],
      "filing_cities": [
        "ATLANTA",
        "SANDY SPRINGS"
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
      "company": "OpenTable",
      "normalized": "OPENTABLE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "OPENTABLE",
      "legal_names": [
        "OPENTABLE INC",
        "OpenTable, Inc."
      ],
      "approvals": 31,
      "denials": 5,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 13,
      "filing_states": [
        "CA",
        "CT"
      ],
      "filing_cities": [
        "SAN FRANCISCO",
        "STAMFORD"
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
      "company": "OPSWAT",
      "normalized": "OPSWAT",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "OPSWAT",
      "legal_names": [
        "OPSWAT INC"
      ],
      "approvals": 3,
      "denials": 1,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CA",
        "FL"
      ],
      "filing_cities": [
        "SAN FRANCISCO",
        "TAMPA"
      ]
    },
    {
      "company": "Optimal Care",
      "normalized": "OPTIMAL CARE",
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
      "company": "Oral Surgery Partners",
      "normalized": "ORAL SURGERY PARTNERS",
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
      "company": "Orion Innovation",
      "normalized": "ORION INNOVATION",
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
      "company": "Otterbein SeniorLife",
      "normalized": "OTTERBEIN SENIORLIFE",
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
      "company": "Ouihelp",
      "normalized": "OUIHELP",
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
      "company": "Ōura",
      "normalized": "URA",
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
      "company": "Panthalassa",
      "normalized": "PANTHALASSA",
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
      "company": "Parloa",
      "normalized": "PARLOA",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "PARLOA",
      "legal_names": [
        "PARLOA INC"
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
      "company": "Path Robotics",
      "normalized": "PATH ROBOTICS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PATH ROBOTICS",
      "legal_names": [
        "PATH ROBOTICS INC",
        "PATH ROBOTICS INC.",
        "PATH ROBOTICS, INC."
      ],
      "approvals": 17,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 10,
      "filing_states": [
        "OH"
      ],
      "filing_cities": [
        "COLUMBUS"
      ]
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
      "company": "Payoneer",
      "normalized": "PAYONEER",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PAYONEER",
      "legal_names": [
        "PAYONEER INC",
        "Payoneer Inc."
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
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "PayPay",
      "normalized": "PAYPAY",
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
      "company": "Pearce Services",
      "normalized": "PEARCE SERVICES",
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
      "company": "Pediatrics Plus Website",
      "normalized": "PEDIATRICS PLUS WEBSITE",
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
      "company": "Peregrine Technologies",
      "normalized": "PEREGRINE TECHNOLOGIES",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "PEREGRINE TECHNOLOGIES",
      "legal_names": [
        "Peregrine Technologies, Inc."
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
      "company": "PharmaCann",
      "normalized": "PHARMACANN",
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
      "company": "phData",
      "normalized": "PHDATA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PHDATA",
      "legal_names": [
        "PHDATA INC",
        "phData, Inc."
      ],
      "approvals": 28,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 8,
      "filing_states": [
        "MN"
      ],
      "filing_cities": [
        "MINNEAPOLIS"
      ]
    },
    {
      "company": "Philz Coffee",
      "normalized": "PHILZ COFFEE",
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
      "company": "PhyNet Dermatology LLC (External)",
      "normalized": "PHYNET DERMATOLOGY LLC EXTERNAL",
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
      "company": "Picnic",
      "normalized": "PICNIC",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "MISSION HEALTH LABS INC DBA PICNIC",
      "legal_names": [
        "MISSION HEALTH LABS INC DBA PICNIC"
      ],
      "approvals": 4,
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
      "company": "Ping Identity",
      "normalized": "PING IDENTITY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PING IDENTITY",
      "legal_names": [
        "PING IDENTITY CORPORATION",
        "Ping Identity Corporation"
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 8,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "DENVER"
      ]
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
      "company": "Plata Card",
      "normalized": "PLATA CARD",
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
      "company": "PlayStation Global",
      "normalized": "PLAYSTATION GLOBAL",
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
      "company": "PMG",
      "normalized": "PMG",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "PETROLEUM MARKETING GROUP DBA PMG",
      "legal_names": [
        "PETROLEUM MARKETING GROUP DBA PMG"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "FALLS CHURCH"
      ]
    },
    {
      "company": "Podium",
      "normalized": "PODIUM",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "PODIUM",
      "legal_names": [
        "PODIUM CORPORATION"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 0,
      "filing_states": [
        "UT"
      ],
      "filing_cities": [
        "LEHI"
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
      "company": "Poland and Middle-Eastern Europe",
      "normalized": "POLAND AND MIDDLE EASTERN EUROPE",
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
      "company": "Polaroid",
      "normalized": "POLAROID",
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
      "company": "Pomelo Care",
      "normalized": "POMELO CARE",
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
      "company": "Power Digital",
      "normalized": "POWER DIGITAL",
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
      "company": "POWERX",
      "normalized": "POWERX",
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
      "company": "Precision AQ",
      "normalized": "PRECISION AQ",
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
      "company": "Precision for Medicine",
      "normalized": "PRECISION FOR MEDICINE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PRECISION FOR MEDICINE",
      "legal_names": [
        "PRECISION FOR MEDICINE INC",
        "Precision for Medicine, Inc."
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "MD"
      ],
      "filing_cities": [
        "BETHESDA",
        "FREDERICK"
      ]
    },
    {
      "company": "Precision Medicine Group",
      "normalized": "PRECISION MEDICINE GROUP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PRECISION MEDICINE GROUP",
      "legal_names": [
        "PRECISION MEDICINE GROUP LLC",
        "Precision Medicine Group, LLC"
      ],
      "approvals": 28,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "MA",
        "MD"
      ],
      "filing_cities": [
        "BETHESDA",
        "BOSTON"
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
      "company": "Presidents Summit",
      "normalized": "PRESIDENTS SUMMIT",
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
      "company": "PrimeWorks",
      "normalized": "PRIMEWORKS",
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
      "company": "Private Equity Insights",
      "normalized": "PRIVATE EQUITY INSIGHTS",
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
      "company": "Proof",
      "normalized": "PROOF",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "PROOF",
      "legal_names": [
        "PROOF LLC"
      ],
      "approvals": 5,
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
        "SAN JOSE",
        "WOODLAND HILLS"
      ]
    },
    {
      "company": "ProperExpression",
      "normalized": "PROPEREXPRESSION",
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
      "company": "Property Leads",
      "normalized": "PROPERTY LEADS",
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
      "company": "Proton",
      "normalized": "PROTON",
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
      "company": "PubMatic",
      "normalized": "PUBMATIC",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PUBMATIC",
      "legal_names": [
        "PUBMATIC INC",
        "PUBMATIC, INC.",
        "PubMatic, Inc."
      ],
      "approvals": 43,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 24,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
    },
    {
      "company": "Pugpig",
      "normalized": "PUGPIG",
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
      "company": "Pulse Healthcare",
      "normalized": "PULSE HEALTHCARE",
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
      "company": "Qualtrics",
      "normalized": "QUALTRICS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "QUALTRICS",
      "legal_names": [
        "QUALTRICS LLC",
        "Qualtrics, LLC"
      ],
      "approvals": 190,
      "denials": 3,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 96,
      "filing_states": [
        "UT"
      ],
      "filing_cities": [
        "PROVO"
      ]
    },
    {
      "company": "Quantum Space",
      "normalized": "QUANTUM SPACE",
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
      "company": "QuEra Computing, Inc.",
      "normalized": "QUERA COMPUTING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "QUERA COMPUTING",
      "legal_names": [
        "QUERA COMPUTING INC",
        "QuEra Computing Inc.",
        "QuEra Computing Incorporated"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 9,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "BOSTON",
        "BRIGHTON"
      ]
    },
    {
      "company": "Quest Defense Systems & Solutions, Inc.",
      "normalized": "QUEST DEFENSE SYSTEMS AND SOLUTIONS",
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
      "company": "Quince",
      "normalized": "QUINCE",
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
      "company": "Raisin",
      "normalized": "RAISIN",
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
      "company": "Re:Build Manufacturing",
      "normalized": "RE BUILD MANUFACTURING",
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
      "company": "Real Chemistry",
      "normalized": "REAL CHEMISTRY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WEISSCOMM GROUP LTD DBA REAL CHEMISTRY",
      "legal_names": [
        "The Weisscomm Group LTD d/b/a Real Chemistry",
        "WEISSCOMM GROUP LTD DBA REAL CHEMISTRY"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA",
        "NJ",
        "NY"
      ],
      "filing_cities": [
        "BEVERLY HILLS",
        "FLORHAM PARK",
        "NEW YORK CITY",
        "SAN FRANCISCO"
      ]
    },
    {
      "company": "Realtor.com Careers",
      "normalized": "REALTOR COM CAREERS",
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
      "company": "Red Ventures",
      "normalized": "RED VENTURES",
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
      "company": "Redstone Residential",
      "normalized": "REDSTONE RESIDENTIAL",
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
      "company": "Reformation",
      "normalized": "REFORMATION",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "LYMI INC DBA REFORMATION",
      "legal_names": [
        "LYMI INC DBA REFORMATION"
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
        "VERNON"
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
      "company": "Retail Insights",
      "normalized": "RETAIL INSIGHTS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "RETAIL INSIGHTS",
      "legal_names": [
        "RETAIL INSIGHTS LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NJ"
      ],
      "filing_cities": [
        "COLONIA"
      ]
    },
    {
      "company": "Revance",
      "normalized": "REVANCE",
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
      "company": "Reveleer",
      "normalized": "REVELEER",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "HLTH DATA VISION INC DBA REVELEER",
      "legal_names": [
        "HEALTH DATA VISION INC DBA REVELEER",
        "HLTH DATA VISION INC DBA REVELEER"
      ],
      "approvals": 2,
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
        "GLENDALE"
      ]
    },
    {
      "company": "Revlon Corporate",
      "normalized": "REVLON CORPORATE",
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
      "company": "Revolution Medicines",
      "normalized": "REVOLUTION MEDICINES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "REVOLUTION MEDICINES",
      "legal_names": [
        "REVOLUTION MEDICINES INC",
        "REVOLUTION MEDICINES, INC."
      ],
      "approvals": 9,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 13,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "REDWOOD CITY"
      ]
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
      "company": "Rippling",
      "normalized": "RIPPLING",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "PEOPLE CENTER INC D B A RIPPLING",
      "legal_names": [
        "PEOPLE CENTER INC D B A RIPPLING",
        "PEOPLE CENTER INC D/B/A RIPPLING",
        "PEOPLE CTR INC D/B/A RIPPLING",
        "People Center, Inc. d/b/a Rippling"
      ],
      "approvals": 163,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 89,
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
      "company": "Rockstar Games",
      "normalized": "ROCKSTAR GAMES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ROCKSTAR GAMES",
      "legal_names": [
        "ROCKSTAR GAMES INC",
        "Rockstar Games, Inc."
      ],
      "approvals": 36,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 13,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
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
      "company": "RTB House",
      "normalized": "RTB HOUSE",
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
      "company": "RZR Global Inc.",
      "normalized": "RZR GLOBAL",
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
      "company": "SalesDraft Recruiting",
      "normalized": "SALESDRAFT RECRUITING",
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
      "company": "SambaNova",
      "normalized": "SAMBANOVA",
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
      "company": "Samsung Semiconductor",
      "normalized": "SAMSUNG SEMICONDUCTOR",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SAMSUNG SEMICONDUCTOR",
      "legal_names": [
        "SAMSUNG SEMICONDUCTOR INC",
        "Samsung Semiconductor, Inc."
      ],
      "approvals": 245,
      "denials": 4,
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
        "SAN JOSE"
      ]
    },
    {
      "company": "Sand Tech Holdings Limited",
      "normalized": "SAND TECH HOLDINGS",
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
      "company": "Saxbys",
      "normalized": "SAXBYS",
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
      "company": "Scout Motors",
      "normalized": "SCOUT MOTORS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "SCOUT MOTORS",
      "legal_names": [
        "Scout Motors Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 8,
      "filing_states": [
        "SC",
        "VA"
      ],
      "filing_cities": [
        "COLUMBIA",
        "MCLEAN"
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
      "company": "Secretariat",
      "normalized": "SECRETARIAT",
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
      "company": "Seneca Holdings",
      "normalized": "SENECA HOLDINGS",
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
      "company": "SentinelOne",
      "normalized": "SENTINELONE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SENTINELONE",
      "legal_names": [
        "SENTINELONE INC",
        "SentinelOne, Inc."
      ],
      "approvals": 19,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 12,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "MOUNTAIN VIEW"
      ]
    },
    {
      "company": "Sezzle",
      "normalized": "SEZZLE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SEZZLE",
      "legal_names": [
        "SEZZLE INC",
        "Sezzle Inc.",
        "Sezzle, Inc."
      ],
      "approvals": 28,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 17,
      "filing_states": [
        "MN"
      ],
      "filing_cities": [
        "MINNEAPOLIS"
      ]
    },
    {
      "company": "SharkNinja",
      "normalized": "SHARKNINJA",
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
      "company": "Shields Health Solutions",
      "normalized": "SHIELDS HEALTH SOLUTIONS",
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
      "company": "ShipBob, Inc.",
      "normalized": "SHIPBOB",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SHIPBOB",
      "legal_names": [
        "SHIPBOB INC",
        "ShipBob, Inc."
      ],
      "approvals": 10,
      "denials": 1,
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
      "company": "Similarweb",
      "normalized": "SIMILARWEB",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SIMILARWEB",
      "legal_names": [
        "SIMILARWEB INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 3,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Simtra BioPharma Solutions",
      "normalized": "SIMTRA BIOPHARMA SOLUTIONS",
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
      "company": "Sitreps",
      "normalized": "SITREPS",
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
      "company": "SK hynix America",
      "normalized": "SK HYNIX AMERICA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SK HYNIX AMERICA",
      "legal_names": [
        "SK HYNIX AMERICA INC",
        "SK hynix America inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN JOSE"
      ]
    },
    {
      "company": "Skilled Wound Care",
      "normalized": "SKILLED WOUND CARE",
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
      "company": "Skin Laundry",
      "normalized": "SKIN LAUNDRY",
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
      "company": "SkyGeo",
      "normalized": "SKYGEO",
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
      "company": "Smartly",
      "normalized": "SMARTLY",
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
      "company": "Smartsheet",
      "normalized": "SMARTSHEET",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SMARTSHEET",
      "legal_names": [
        "SMARTSHEET INC",
        "SMARTSHEET INC.",
        "Smartsheet, Inc."
      ],
      "approvals": 99,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 46,
      "filing_states": [
        "WA"
      ],
      "filing_cities": [
        "BELLEVUE"
      ]
    },
    {
      "company": "Snap! Mobile, Inc.",
      "normalized": "SNAP MOBILE",
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
      "company": "Soho House & Co.",
      "normalized": "SOHO HOUSE AND",
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
      "company": "SOL Mental Health",
      "normalized": "SOL MENTAL HEALTH",
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
      "company": "Solaris",
      "normalized": "SOLARIS",
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
      "company": "SonicWall",
      "normalized": "SONICWALL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SONICWALL",
      "legal_names": [
        "SONICWALL INC",
        "SonicWall, Inc."
      ],
      "approvals": 30,
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
        "MILPITAS"
      ]
    },
    {
      "company": "Sono Bello",
      "normalized": "SONO BELLO",
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
      "company": "Sony Interactive Entertainment Inc.",
      "normalized": "SONY INTERACTIVE ENTERTAINMENT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SONY INTERACTIVE ENTERTAINMENT",
      "legal_names": [
        "SONY INTERACTIVE ENTERTAINMENT LLC"
      ],
      "approvals": 398,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 174,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN MATEO"
      ]
    },
    {
      "company": "Sony Music Global Job Board",
      "normalized": "SONY MUSIC GLOBAL JOB BOARD",
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
      "company": "Sorare",
      "normalized": "SORARE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SORARE",
      "legal_names": [
        "SORARE INC"
      ],
      "approvals": 4,
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
      "company": "Sotheby's",
      "normalized": "SOTHEBY S",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "SOTHEBY S",
      "legal_names": [
        "Sotheby's, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 3,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Space Kinetic",
      "normalized": "SPACE KINETIC",
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
      "company": "SpaceXAI",
      "normalized": "SPACEXAI",
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
      "company": "Spaulding Ridge",
      "normalized": "SPAULDING RIDGE",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SPAULDING RIDGE",
      "legal_names": [
        "SPAULDING RIDGE LLC"
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "Specialty1 Partners",
      "normalized": "SPECIALTY1 PARTNERS",
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
      "company": "Speechify",
      "normalized": "SPEECHIFY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SPEECHIFY",
      "legal_names": [
        "SPEECHIFY INC",
        "Speechify Inc.",
        "Speechify, Inc."
      ],
      "approvals": 3,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 4,
      "filing_states": [
        "FL"
      ],
      "filing_cities": [
        "SAINT PETERSBURG",
        "ST. PETERSBURG"
      ]
    },
    {
      "company": "Spektrum",
      "normalized": "SPEKTRUM",
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
      "company": "Spire",
      "normalized": "SPIRE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "SPIRE",
      "legal_names": [
        "DIGIPRESS DBA SPIRE",
        "SPIRE INC",
        "Spire Inc.",
        "Spire, Inc."
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
        "MA",
        "MO"
      ],
      "filing_cities": [
        "PEABODY",
        "SAINT LOUIS",
        "ST. LOUIS"
      ]
    },
    {
      "company": "Sports Reference",
      "normalized": "SPORTS REFERENCE",
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
      "company": "SpotHopper",
      "normalized": "SPOTHOPPER",
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
      "company": "Spotlight Marketing and Branding",
      "normalized": "SPOTLIGHT MARKETING AND BRANDING",
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
      "company": "Spring Health",
      "normalized": "SPRING HEALTH",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SPRING CARE INC DBA SPRING HEALTH",
      "legal_names": [
        "SPRING CARE INC DBA SPRING HEALTH"
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "NJ",
        "NY"
      ],
      "filing_cities": [
        "JERSEY CITY",
        "NEW YORK"
      ]
    },
    {
      "company": "SPS North America",
      "normalized": "SPS NORTH AMERICA",
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
      "company": "StackAdapt",
      "normalized": "STACKADAPT",
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
      "company": "Starling Oncology",
      "normalized": "STARLING ONCOLOGY",
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
      "company": "StepStone Group",
      "normalized": "STEPSTONE GROUP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "STEPSTONE GROUP",
      "legal_names": [
        "STEPSTONE GROUP LP",
        "StepStone Group LP"
      ],
      "approvals": 14,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022
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
      "company": "Stoke Space",
      "normalized": "STOKE SPACE",
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
      "company": "STR",
      "normalized": "STR",
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
      "company": "Strategic HR Client Job Openings",
      "normalized": "STRATEGIC HR CLIENT JOB OPENINGS",
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
      "company": "Stratolaunch",
      "normalized": "STRATOLAUNCH",
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
      "company": "Strive Health",
      "normalized": "STRIVE HEALTH",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "STRIVE HEALTH",
      "legal_names": [
        "STRIVE HEALTH LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "DENVER"
      ]
    },
    {
      "company": "Student Medicover",
      "normalized": "STUDENT MEDICOVER",
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
      "company": "STUDS",
      "normalized": "STUDS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "STUDS",
      "legal_names": [
        "Studs, Inc."
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
      "company": "Success Academy Charter Schools",
      "normalized": "SUCCESS ACADEMY CHARTER SCHOOLS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "SUCCESS ACADEMY CHARTER SCHOOLS",
      "legal_names": [
        "Success Academy Charter Schools, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 3,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Suitsupply",
      "normalized": "SUITSUPPLY",
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
      "company": "Summit Therapeutics",
      "normalized": "SUMMIT THERAPEUTICS",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "SUMMIT THERAPEUTICS",
      "legal_names": [
        "Summit Therapeutics Inc.",
        "Summit Therapeutics, Inc."
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 3,
      "filing_states": [
        "CA",
        "FL"
      ],
      "filing_cities": [
        "MENLO PARK",
        "MIAMI"
      ]
    },
    {
      "company": "SumUp",
      "normalized": "SUMUP",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "SUMUP",
      "legal_names": [
        "SUMUP INC"
      ],
      "approvals": 1,
      "denials": 1,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "CO"
      ],
      "filing_cities": [
        "BOULDER"
      ]
    },
    {
      "company": "Sunday",
      "normalized": "SUNDAY",
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
      "company": "Sunnyside*",
      "normalized": "SUNNYSIDE",
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
      "company": "Svetness Personal Training",
      "normalized": "SVETNESS PERSONAL TRAINING",
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
      "company": "Taboola",
      "normalized": "TABOOLA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TABOOLA",
      "legal_names": [
        "TABOOLA INC",
        "Taboola, Inc."
      ],
      "approvals": 8,
      "denials": 0,
      "fiscal_years": [
        2021,
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
      "company": "Tactile Medical",
      "normalized": "TACTILE MEDICAL",
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
      "company": "Tailscale",
      "normalized": "TAILSCALE",
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
      "company": "takealot.com",
      "normalized": "TAKEALOT COM",
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
      "company": "TalentNeuron",
      "normalized": "TALENTNEURON",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "TALENTNEURON",
      "legal_names": [
        "TALENTNEURON LLC"
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
      "company": "Talkdesk",
      "normalized": "TALKDESK",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "TALKDESK",
      "legal_names": [
        "TALKDESK INC"
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
        "WALNUT"
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
      "company": "Talkspace Psychiatry",
      "normalized": "TALKSPACE PSYCHIATRY",
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
      "company": "Tanium",
      "normalized": "TANIUM",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TANIUM",
      "legal_names": [
        "TANIUM INC",
        "Tanium Inc."
      ],
      "approvals": 18,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 8,
      "filing_states": [
        "CA",
        "WA"
      ],
      "filing_cities": [
        "EMERYVILLE",
        "KIRKLAND"
      ]
    },
    {
      "company": "Tatari",
      "normalized": "TATARI",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TATARI",
      "legal_names": [
        "TATARI INC",
        "Tatari, Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2021
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
      "company": "Teads",
      "normalized": "TEADS",
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
      "company": "Tecovas",
      "normalized": "TECOVAS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TECOVAS",
      "legal_names": [
        "TECOVAS INC",
        "TECOVAS, INC."
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 1,
      "filing_states": [
        "TX"
      ],
      "filing_cities": [
        "AUSTIN"
      ]
    },
    {
      "company": "TEGNA Inc.",
      "normalized": "TEGNA",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "TEGNA",
      "legal_names": [
        "TEGNA INC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "MC LEAN"
      ]
    },
    {
      "company": "Teneo external feed for LinkedIn",
      "normalized": "TENEO EXTERNAL FEED FOR LINKEDIN",
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
      "company": "Texas Car Title & Payday Loan Services, Inc",
      "normalized": "TEXAS CAR TITLE AND PAYDAY LOAN SERVICES",
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
      "company": "The Brattle Group",
      "normalized": "THE BRATTLE GROUP",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "THE BRATTLE GROUP",
      "legal_names": [
        "THE BRATTLE GROUP",
        "The Brattle Group"
      ],
      "approvals": 36,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 53,
      "filing_states": [
        "DC",
        "MA"
      ],
      "filing_cities": [
        "BOSTON",
        "WASHINGTON"
      ]
    },
    {
      "company": "The Copper River Family of Companies",
      "normalized": "THE COPPER RIVER FAMILY OF COMPANIES",
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
      "company": "The N2 Company",
      "normalized": "THE N2 COMPANY",
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
      "company": "The National Football League",
      "normalized": "THE NATIONAL FOOTBALL LEAGUE",
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
      "company": "The Nuclear Company",
      "normalized": "THE NUCLEAR COMPANY",
      "sponsors": true,
      "evidence": "dol_lca",
      "matched_key": "THE NUCLEAR COMPANY",
      "legal_names": [
        "The Nuclear Company"
      ],
      "approvals": 0,
      "denials": 0,
      "fiscal_years": [],
      "lca_certifications": 1,
      "filing_states": [
        "KY"
      ],
      "filing_cities": [
        "LEXINGTON"
      ]
    },
    {
      "company": "The Periscope Group",
      "normalized": "THE PERISCOPE GROUP",
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
      "company": "The Princeton Review",
      "normalized": "THE PRINCETON REVIEW",
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
      "company": "The Quality Group",
      "normalized": "THE QUALITY GROUP",
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
      "company": "The Quality Group GmbH",
      "normalized": "THE QUALITY GROUP",
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
      "company": "The Scion Group",
      "normalized": "THE SCION GROUP",
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
      "company": "The Specialty Alliance",
      "normalized": "THE SPECIALTY ALLIANCE",
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
      "company": "The Trade Desk",
      "normalized": "THE TRADE DESK",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "THE TRADE DESK",
      "legal_names": [
        "THE TRADE DESK INC",
        "THE TRADE DESK, INC."
      ],
      "approvals": 69,
      "denials": 2,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 55,
      "filing_states": [
        "CA",
        "NY"
      ],
      "filing_cities": [
        "IRVINE",
        "VENTURA"
      ]
    },
    {
      "company": "Theoria Medical",
      "normalized": "THEORIA MEDICAL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "THEORIA MEDICAL",
      "legal_names": [
        "THEORIA MEDICAL",
        "Theoria Medical"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 1,
      "filing_states": [
        "MI"
      ],
      "filing_cities": [
        "NOVI"
      ]
    },
    {
      "company": "Think Academy US",
      "normalized": "THINK ACADEMY US",
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
      "company": "Third Way",
      "normalized": "THIRD WAY",
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
      "company": "Thoughtworks",
      "normalized": "THOUGHTWORKS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "THOUGHTWORKS",
      "legal_names": [
        "THOUGHTWORKS INC",
        "Thoughtworks, Inc."
      ],
      "approvals": 167,
      "denials": 6,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 38,
      "filing_states": [
        "IL"
      ],
      "filing_cities": [
        "CHICAGO"
      ]
    },
    {
      "company": "Thunes",
      "normalized": "THUNES",
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
      "company": "Titan Security Group",
      "normalized": "TITAN SECURITY GROUP",
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
      "company": "Too Good To Go",
      "normalized": "TOO GOOD TO GO",
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
      "company": "TooJay’s Deli • Bakery • Restaurant",
      "normalized": "TOOJAY S DELI BAKERY RESTAURANT",
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
      "company": "Torc Robotics",
      "normalized": "TORC ROBOTICS",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TORC ROBOTICS",
      "legal_names": [
        "TORC ROBOTICS INC",
        "TORC ROBOTICS, INC.",
        "TORC Robotics, Inc."
      ],
      "approvals": 56,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 90,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "BLACKSBURG"
      ]
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
      "company": "Townsquare Media",
      "normalized": "TOWNSQUARE MEDIA",
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
      "company": "Trace3",
      "normalized": "TRACE3",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TRACE3",
      "legal_names": [
        "TRACE3 LLC",
        "Trace3, LLC"
      ],
      "approvals": 5,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "IRVINE"
      ]
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
      "company": "Transparent Hiring",
      "normalized": "TRANSPARENT HIRING",
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
      "company": "Triumvirate Environmental",
      "normalized": "TRIUMVIRATE ENVIRONMENTAL",
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
      "company": "trivago",
      "normalized": "TRIVAGO",
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
      "company": "True Anomaly",
      "normalized": "TRUE ANOMALY",
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
      "company": "Tulip Interfaces",
      "normalized": "TULIP INTERFACES",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "TULIP INTERFACES",
      "legal_names": [
        "TULIP INTERFACES INC",
        "Tulip Interfaces, Inc."
      ],
      "approvals": 7,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 7,
      "filing_states": [
        "MA"
      ],
      "filing_cities": [
        "SOMERVILLE"
      ]
    },
    {
      "company": "Turf Masters Brands",
      "normalized": "TURF MASTERS BRANDS",
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
      "company": "Turning Point USA",
      "normalized": "TURNING POINT USA",
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
      "company": "Two Six Technologies",
      "normalized": "TWO SIX TECHNOLOGIES",
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
      "company": "Tyson & Mendes LLP",
      "normalized": "TYSON AND MENDES",
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
      "company": "Ubiquiti",
      "normalized": "UBIQUITI",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "UBIQUITI",
      "legal_names": [
        "UBIQUITI INC"
      ],
      "approvals": 12,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "MI",
        "NY"
      ],
      "filing_cities": [
        "ANN ARBOR",
        "NEW YORK"
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
      "company": "United Media",
      "normalized": "UNITED MEDIA",
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
      "company": "United Vein & Vascular Centers",
      "normalized": "UNITED VEIN AND VASCULAR CENTERS",
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
      "company": "Upstart",
      "normalized": "UPSTART",
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
      "company": "Upstream Rehabilitation",
      "normalized": "UPSTREAM REHABILITATION",
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
      "company": "Ursa Major",
      "normalized": "URSA MAJOR",
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
      "company": "US Conec, Ltd.",
      "normalized": "US CONEC",
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
      "company": "Vaco LLC",
      "normalized": "VACO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VACO",
      "legal_names": [
        "VACO LLC",
        "Vaco LLC"
      ],
      "approvals": 10,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 1,
      "filing_states": [
        "CA",
        "TN",
        "TX"
      ],
      "filing_cities": [
        "BRENTWOOD",
        "HOUSTON",
        "SANTA CLARA"
      ]
    },
    {
      "company": "Vail Health Hospital",
      "normalized": "VAIL HEALTH HOSPITAL",
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
      "company": "Valar Atomics",
      "normalized": "VALAR ATOMICS",
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
      "company": "Valtech",
      "normalized": "VALTECH",
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
      "company": "Van Leeuwen Ice Cream",
      "normalized": "VAN LEEUWEN ICE CREAM",
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
      "company": "Vast",
      "normalized": "VAST",
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
      "company": "Vaxcyte",
      "normalized": "VAXCYTE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VAXCYTE",
      "legal_names": [
        "VAXCYTE INC",
        "Vaxcyte, Inc."
      ],
      "approvals": 7,
      "denials": 0,
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
        "FOSTER CITY",
        "SAN CARLOS",
        "SAN MATEO"
      ]
    },
    {
      "company": "VaynerMedia LLC",
      "normalized": "VAYNERMEDIA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VAYNERMEDIA",
      "legal_names": [
        "VAYNERMEDIA LLC",
        "VaynerMedia, LLC"
      ],
      "approvals": 6,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 5,
      "filing_states": [
        "CA",
        "NY"
      ],
      "filing_cities": [
        "CULVER CITY",
        "NEW YORK"
      ]
    },
    {
      "company": "Veeam Software",
      "normalized": "VEEAM SOFTWARE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VEEAM SOFTWARE",
      "legal_names": [
        "VEEAM SOFTWARE CORPORATION",
        "Veeam Software Corporation"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 2,
      "filing_states": [
        "OH",
        "WA"
      ],
      "filing_cities": [
        "COLUMBUS",
        "KIRKLAND"
      ]
    },
    {
      "company": "Veo - Operations Careers",
      "normalized": "VEO OPERATIONS CAREERS",
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
      "company": "Veritas Veterinary Partners",
      "normalized": "VERITAS VETERINARY PARTNERS",
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
      "company": "Verra Mobility",
      "normalized": "VERRA MOBILITY",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "VM CONSOLIDATED INC DBA VERRA MOBILITY",
      "legal_names": [
        "VM CONSOLIDATED INC DBA VERRA MOBILITY"
      ],
      "approvals": 14,
      "denials": 2,
      "fiscal_years": [
        2022,
        2023
      ],
      "lca_certifications": 0,
      "filing_states": [
        "AZ"
      ],
      "filing_cities": [
        "MESA"
      ]
    },
    {
      "company": "Verve",
      "normalized": "VERVE",
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
      "company": "Veterinary Emergency Group (VEG)",
      "normalized": "VETERINARY EMERGENCY GROUP VEG",
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
      "company": "Veterinary Practice Partners",
      "normalized": "VETERINARY PRACTICE PARTNERS",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "VETERINARY PRACTICE PARTNERS",
      "legal_names": [
        "VETERINARY PRACTICE PARTNERS LLC"
      ],
      "approvals": 1,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "PA"
      ],
      "filing_cities": [
        "KING OF PRUSSIA"
      ]
    },
    {
      "company": "VetEvolve",
      "normalized": "VETEVOLVE",
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
      "company": "VetsEZ",
      "normalized": "VETSEZ",
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
      "company": "Via",
      "normalized": "VIA",
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
      "company": "Viral Nation Inc.",
      "normalized": "VIRAL NATION",
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
      "company": "VitalCaring Group",
      "normalized": "VITALCARING GROUP",
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
      "company": "VML",
      "normalized": "VML",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "VML",
      "legal_names": [
        "VML LLC"
      ],
      "approvals": 20,
      "denials": 1,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 15,
      "filing_states": [
        "MI",
        "MO",
        "NY"
      ],
      "filing_cities": [
        "KALAMAZOO",
        "KANSAS CITY",
        "NEW YORK"
      ]
    },
    {
      "company": "VML/WPP Enterprise Solutions",
      "normalized": "VML WPP ENTERPRISE SOLUTIONS",
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
      "company": "Vosyn",
      "normalized": "VOSYN",
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
      "company": "Voyager Technologies, Inc.",
      "normalized": "VOYAGER TECHNOLOGIES",
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
      "company": "VSC Fire & Security",
      "normalized": "VSC FIRE AND SECURITY",
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
      "company": "VTEX",
      "normalized": "VTEX",
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
      "company": "Vulcan Elements",
      "normalized": "VULCAN ELEMENTS",
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
      "company": "Walden Security",
      "normalized": "WALDEN SECURITY",
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
      "company": "Wargaming",
      "normalized": "WARGAMING",
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
      "company": "Wave",
      "normalized": "WAVE",
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
      "company": "Wayve",
      "normalized": "WAYVE",
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
      "company": "WEBB Traders",
      "normalized": "WEBB TRADERS",
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
      "company": "Weight Watchers",
      "normalized": "WEIGHT WATCHERS",
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
      "company": "WelbeHealth",
      "normalized": "WELBEHEALTH",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WELBEHEALTH",
      "legal_names": [
        "WELBEHEALTH LLC",
        "WelbeHealth, LLC"
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
        "LONG BEACH",
        "MENLO PARK"
      ]
    },
    {
      "company": "Wellhub",
      "normalized": "WELLHUB",
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
      "company": "Wellthy Care Network",
      "normalized": "WELLTHY CARE NETWORK",
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
      "company": "Wildlife Studios",
      "normalized": "WILDLIFE STUDIOS",
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
      "company": "Wilson Elser - Attorneys",
      "normalized": "WILSON ELSER ATTORNEYS",
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
      "company": "Wilson Elser - Business & Legal Professionals",
      "normalized": "WILSON ELSER BUSINESS AND LEGAL PROFESSIONALS",
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
      "company": "Wing",
      "normalized": "WING",
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
      "company": "Wolt - English",
      "normalized": "WOLT ENGLISH",
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
      "company": "Wolt - Hebrew",
      "normalized": "WOLT HEBREW",
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
      "company": "Wonderschool",
      "normalized": "WONDERSCHOOL",
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
      "company": "Woolpert",
      "normalized": "WOOLPERT",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WOOLPERT",
      "legal_names": [
        "WOOLPERT INC",
        "Woolpert Inc",
        "Woolpert, Inc."
      ],
      "approvals": 3,
      "denials": 1,
      "fiscal_years": [
        2021
      ],
      "lca_certifications": 18,
      "filing_states": [
        "OH",
        "TX"
      ],
      "filing_cities": [
        "BEAVERCREEK",
        "CYPRESS",
        "DAYTON"
      ]
    },
    {
      "company": "Workato",
      "normalized": "WORKATO",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WORKATO",
      "legal_names": [
        "WORKATO INC",
        "Workato Inc."
      ],
      "approvals": 21,
      "denials": 1,
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
        "MOUNTAIN VIEW",
        "PALO ALTO",
        "SAN MATEO"
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
      "company": "WorldStrides",
      "normalized": "WORLDSTRIDES",
      "sponsors": true,
      "evidence": "uscis_h1b",
      "matched_key": "WORLDSTRIDES",
      "legal_names": [
        "WORLDSTRIDES"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2022
      ],
      "lca_certifications": 0,
      "filing_states": [
        "VA"
      ],
      "filing_cities": [
        "CHARLOTTESVILLE"
      ]
    },
    {
      "company": "Woven Care",
      "normalized": "WOVEN CARE",
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
      "company": "WPP",
      "normalized": "WPP",
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
      "company": "WPP Media",
      "normalized": "WPP MEDIA",
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
      "company": "Wrike",
      "normalized": "WRIKE",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "WRIKE",
      "legal_names": [
        "WRIKE INC",
        "Wrike, Inc."
      ],
      "approvals": 4,
      "denials": 0,
      "fiscal_years": [
        2023
      ],
      "lca_certifications": 2,
      "filing_states": [
        "CA"
      ],
      "filing_cities": [
        "SAN DIEGO"
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
      "company": "Xometry",
      "normalized": "XOMETRY",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "XOMETRY",
      "legal_names": [
        "XOMETRY INC",
        "Xometry"
      ],
      "approvals": 2,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022
      ],
      "lca_certifications": 8,
      "filing_states": [
        "MD"
      ],
      "filing_cities": [
        "GAITHERSBURG",
        "NORTH BETHESDA"
      ]
    },
    {
      "company": "XP Inc.",
      "normalized": "XP",
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
      "company": "YipitData",
      "normalized": "YIPITDATA",
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
      "company": "YipitData (Alternative)",
      "normalized": "YIPITDATA ALTERNATIVE",
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
      "company": "Yource",
      "normalized": "YOURCE",
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
      "company": "Zeta Global",
      "normalized": "ZETA GLOBAL",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ZETA GLOBAL",
      "legal_names": [
        "ZETA GLOBAL CORP",
        "ZETA GLOBAL CORP."
      ],
      "approvals": 18,
      "denials": 0,
      "fiscal_years": [
        2021,
        2022,
        2023
      ],
      "lca_certifications": 20,
      "filing_states": [
        "NY"
      ],
      "filing_cities": [
        "NEW YORK"
      ]
    },
    {
      "company": "Zipline",
      "normalized": "ZIPLINE",
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
      "company": "Zone 5 Technologies",
      "normalized": "ZONE 5 TECHNOLOGIES",
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
    },
    {
      "company": "Zynga",
      "normalized": "ZYNGA",
      "sponsors": true,
      "evidence": "both",
      "matched_key": "ZYNGA",
      "legal_names": [
        "ZYNGA INC",
        "Zynga, Inc."
      ],
      "approvals": 54,
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
        "SAN FRANCISCO",
        "SAN MATEO"
      ]
    }
  ]
};
