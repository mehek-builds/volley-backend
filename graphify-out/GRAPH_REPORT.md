# Graph Report - .  (2026-07-26)

## Corpus Check
- 124 files · ~105,726 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 554 nodes · 1017 edges · 23 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `measureResumeLayout()` - 14 edges
2. `usableWidth()` - 11 edges
3. `prepare()` - 11 edges
4. `submit()` - 11 edges
5. `nextReview()` - 10 edges
6. `prepareManaged()` - 10 edges
7. `resolveSalary()` - 9 edges
8. `planResumeLayout()` - 9 edges
9. `renderResumePdf()` - 9 edges
10. `findStatedRanges()` - 8 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (18): deriveEditedTerms(), overlapScore(), terms(), approvedReviewSpec(), reviewSpec(), applyResumePolicy(), deriveCandidateContext(), metricCount() (+10 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (18): buildVerificationEmail(), googleIdentityFromClaims(), googleRegistrationValues(), googleVerificationFailure(), GoogleVerificationUnavailable, hashCode(), issuedBeforeEpoch(), requireAuth() (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (18): APOLLO_HEADERS(), apolloSearchIds(), fetchApolloContacts(), personaTitleBuckets(), learnPattern(), resolveEmail(), orderedPatterns(), renderTopCandidates() (+10 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (10): buildApp(), getApp(), handler(), start(), trustProxySetting(), allowHourly(), bumpCounter(), hourPeriod() (+2 more)

### Community 4 - "Community 4"
Cohesion: 0.15
Nodes (33): contactLine(), createResumeDocument(), drawEducation(), drawEntrySection(), drawSectionHeader(), drawSplitLine(), educationHeight(), educationPosition() (+25 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (14): candidateContext(), canGenerateCoverLetter(), deleteStoredCoverLetter(), generateStoredCoverLetter(), persistCoverLetter(), saveStoredCoverLetter(), storedCoverLetter(), deleteBlobsForUser() (+6 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (20): clampExpansion(), interpolate(), resumeDesignAtExpansion(), acronymTokenOf(), bankEntryCorpus(), breaksTie(), bulletClaimIsGrounded(), contentWords() (+12 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (7): decryptRow(), sendProfile(), assertEncryptionKeyConfigured(), decryptField(), encryptField(), FieldDecryptError, getKey()

### Community 8 - "Community 8"
Cohesion: 0.21
Nodes (21): authorizationValidAtClick(), buildPacket(), claimPreparation(), claimSubmission(), controlledChromeExecutable(), discoverAndResolveQuestions(), fail(), holdRevokedSubmission() (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.12
Nodes (18): completeEmailVerificationIfPresent(), safeContinueButton(), visibleOtpField(), waitForCode(), asRecord(), bodyText(), decodeBase64Url(), defaultExecutor() (+10 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (18): buildManagedDiscoveryActions(), buildManagedPortalActions(), canFillReviewedQuestions(), coverLetterUploadSelector(), fillFirst(), fillPortal(), fillReviewedQuestions(), hasCoverLetterUpload() (+10 more)

### Community 11 - "Community 11"
Cohesion: 0.11
Nodes (5): fetchSourceJobs(), normalizeAshbyJobs(), normalizeGreenhouseJobs(), normalizeLeverJobs(), sourceEndpoint()

### Community 12 - "Community 12"
Cohesion: 0.16
Nodes (14): describeRequiredBlocker(), describeUnlabelledBlockers(), humanFieldLabel(), isOpaqueIdentifier(), sanitizeProviderBlockers(), tidyLabel(), classifyField(), isFixedPortalProfileField() (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.23
Nodes (17): collectCurrencies(), currencyPrefixAt(), dedupeRanges(), detectCurrency(), findStatedRanges(), groupDigits(), isProseSalary(), mapCurrencyToken() (+9 more)

### Community 14 - "Community 14"
Cohesion: 0.14
Nodes (10): apiBase(), apiKey(), composioRequest(), authConfigId(), composioClient(), createEmailConnectionLink(), disconnectEmailProvider(), emailConnectionCallbackUrl() (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.15
Nodes (7): browserSessionBody(), config(), createBrowserSession(), getBrowserSession(), managedBrowserErrorMessage(), request(), runManagedBrowser()

### Community 16 - "Community 16"
Cohesion: 0.19
Nodes (7): extractRankedItems(), metricTokens(), numberSignatures(), numStr(), signaturesOf(), splitListSegment(), ungroundedNumbers()

### Community 17 - "Community 17"
Cohesion: 0.26
Nodes (5): createRateLimitHook(), defaultRateLimitConfig(), InMemoryRateLimitStore, policyForRequest(), positiveInteger()

### Community 18 - "Community 18"
Cohesion: 0.27
Nodes (6): buildContextBlock(), draftApplicationAnswer(), normalizeDraftedAnswer(), rankingGroundingFor(), rankingRuleText(), thinRankingWarning()

### Community 19 - "Community 19"
Cohesion: 0.39
Nodes (7): annualize(), answerCompensation(), detectCurrency(), detectUnit(), formatCompensation(), parseStatedCompensation(), toNumber()

### Community 20 - "Community 20"
Cohesion: 0.67
Nodes (0): 

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (0): 

### Community 22 - "Community 22"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **1 isolated node(s):** `GoogleVerificationUnavailable`
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 21`** (1 nodes): `drizzle.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (1 nodes): `submissionStateMachine.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `GoogleVerificationUnavailable` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 6` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._