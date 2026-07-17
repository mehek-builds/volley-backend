# QA shims: DO NOT COMMIT, DO NOT REVERT WITHOUT READING THIS

> ## ⚠️ UPDATED 2026-07-17: R-012 IS RESOLVED. Two of these three shims are now OBSOLETE. The third is NOT.
>
> Mehek topped up Anthropic billing at ~12:55 GST and **credits are live** (verified: a real
> `POST /resume/generate` returns 200 in 19s with a rendered PDF). So the premise below, "the API
> is out of credits", **no longer holds**.
>
> - **`QA_SPEC_DIR` and `QA_ANSWER_DIR` are obsolete.** The real model is back. Do not hand-author
>   specs or essays any more; just leave the env vars unset and the shims are inert.
> - **The `resume.ts` `data:` URL fallback MUST STAY.** It was never an R-012 workaround. It keys
>   on the absence of `BLOB_READ_WRITE_TOKEN`, which is a **local environment** fact, not a credits
>   fact, and local QA has no blob token. **Removing it cost 20 minutes:** with the model working
>   perfectly, `/resume/generate` still returned `500 "Failed to store generated resume"`
>   (`BlobError: No token found`, `resume.ts:178`). That 500 mimics an R-015-fix failure and is not
>   one. Prod sets the token (Production + Preview), so prod never takes this path.
>
> Original text below, kept for context.

---

Three uncommitted local-only shims let RoleQuick run end-to-end **without the Anthropic API**,
which is out of credits (see the vault's rolequick-issue-register, R-012). They exist because the
whole point of the QA run is to exercise RoleQuick's real fill path on real ATS forms; with no
credits, resume-gen and essay-drafting both die and nothing can be tested.

| File | Env var | What it does |
|---|---|---|
| `src/llm/resumeSpec.ts` | `QA_SPEC_DIR` | reads the tailoring spec from `<dir>/<company-slug>.json` instead of calling the model |
| `src/llm/applicationAnswer.ts` | `QA_ANSWER_DIR` | reads essay answers from `<dir>/<company-slug>.json`, a `{questionRegex: answer}` map |
| `src/routes/resume.ts` | `BLOB_READ_WRITE_TOKEN` (absence) | serves the PDF as a `data:` URL when there is no blob token |

All three are **no-ops unless the env var is set**, so they cannot affect prod, which sets neither
`QA_SPEC_DIR` nor `QA_ANSWER_DIR` and always has a blob token.

The content they serve is hand-authored by Claude on Mehek's Claude subscription (her explicit
instruction, 2026-07-17) rather than via the dead API key. Everything downstream runs unchanged:
validation, grounding checks, em-dash stripping, PDF render, attach, field matching, always-ask
holds and the auto-submit countdown.

## Please don't just `git checkout` these

A previous session reverted them mid-run (reasonably, acting on a "must not ship" note), which
silently killed local QA. If you need a clean tree for a build:
```
git stash push src/llm/resumeSpec.ts src/llm/applicationAnswer.ts src/routes/resume.ts
# ...build...
git stash pop
```
Before any real build or release, confirm the bundle is clean:
```
grep -rn "QA_SPEC_DIR\|QA_ANSWER_DIR" src/   # must return nothing in a shipped tree
```
