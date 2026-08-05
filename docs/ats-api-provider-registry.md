# ATS API provider registry

Litos recognizes common ATS and job-board URL families in the API submission diagnostics endpoint. Recognition does not mean Litos can submit. Submission is attempted only when an employer-authorized channel is configured with credentials and durable field mappings.

## Submit-capable channels

These providers have documented employer-authorized application submission endpoints that Litos can call when configured:

| Provider | Official path | Litos status |
|---|---|---|
| Greenhouse | Job Board API `POST /v1/boards/{board_token}/jobs/{id}` with Basic Auth | Implemented |
| Ashby | `applicationForm.submit` with `candidatesWrite` permission and application form paths | Implemented |
| Lever | Postings API `POST /v0/postings/{site}/{postingId}?key=APIKEY` | Implemented |
| SmartRecruiters | Application API `POST /postings/{uuid}/candidates` with `candidate_applications_manage` scope | Recognized, not submitted until explicit consent decisions are configured |

## Recognized diagnostic-only channels

These providers are recognized so operators get a precise unavailable reason instead of a generic browser fallback. They require employer tenant credentials, partner access, consent plumbing, or do not expose a public arbitrary applicant-submit endpoint.

Workable, Workday, iCIMS, BambooHR, JazzHR, Paylocity, Rippling, BreezyHR, Oracle Taleo, SAP SuccessFactors, ADP, UKG, Jobvite, Dayforce, Recruitee, Teamtailor, Personio, Pinpoint, Comeet, Zoho Recruit, Bullhorn, Indeed, LinkedIn, ZipRecruiter, Wellfound, and Handshake.

## Configuration

All credentials are referenced by environment variable name through `LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON`. Secrets are never stored in the JSON itself.

```json
[
  {
    "ats": "greenhouse",
    "board_token": "acme",
    "api_key_env": "GREENHOUSE_ACME_JOB_BOARD_API_KEY"
  },
  {
    "ats": "ashby",
    "organization": "acme",
    "api_key_env": "ASHBY_ACME_API_KEY",
    "field_paths": {
      "name": "_systemfield_name",
      "email": "_systemfield_email",
      "resume": "_systemfield_resume"
    }
  },
  {
    "ats": "lever",
    "site": "acme",
    "api_key_env": "LEVER_ACME_POSTINGS_API_KEY"
  }
]
```

## Verification

`src/lib/atsSubmissionChannels.test.ts` includes:

- Parser trials for Greenhouse, Ashby, and Lever.
- A 30-provider diagnostic table.
- Mocked multipart submit trials for Greenhouse, Ashby, and Lever.
- Missing credential, missing field mapping, and non-2xx failure tests.
