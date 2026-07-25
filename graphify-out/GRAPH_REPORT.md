# Graph Report - .  (2026-07-25)

## Corpus Check
- 119 files · ~99,657 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 514 nodes · 942 edges · 21 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `measureResumeLayout()` - 14 edges
2. `usableWidth()` - 11 edges
3. `prepareManaged()` - 10 edges
4. `prepare()` - 10 edges
5. `submit()` - 10 edges
6. `resolveSalary()` - 9 edges
7. `planResumeLayout()` - 9 edges
8. `renderResumePdf()` - 9 edges
9. `findStatedRanges()` - 8 edges
10. `nextReview()` - 8 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.04
Nodes (21): buildVerificationEmail(), hashCode(), issuedBeforeEpoch(), requireAuth(), sendVerificationEmail(), verificationFailure(), verificationSender(), buildApp() (+13 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (18): deriveEditedTerms(), overlapScore(), terms(), approvedReviewSpec(), reviewSpec(), applyResumePolicy(), deriveCandidateContext(), metricCount() (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (18): APOLLO_HEADERS(), apolloSearchIds(), fetchApolloContacts(), personaTitleBuckets(), learnPattern(), resolveEmail(), orderedPatterns(), renderTopCandidates() (+10 more)

### Community 3 - "Community 3"
Cohesion: 0.15
Nodes (33): contactLine(), createResumeDocument(), drawEducation(), drawEntrySection(), drawSectionHeader(), drawSplitLine(), educationHeight(), educationPosition() (+25 more)

### Community 4 - "Community 4"
Cohesion: 0.1
Nodes (23): describeRequiredBlocker(), describeUnlabelledBlockers(), humanFieldLabel(), isOpaqueIdentifier(), sanitizeProviderBlockers(), tidyLabel(), buildManagedDiscoveryActions(), buildManagedPortalActions() (+15 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (14): candidateContext(), canGenerateCoverLetter(), deleteStoredCoverLetter(), generateStoredCoverLetter(), persistCoverLetter(), saveStoredCoverLetter(), storedCoverLetter(), deleteBlobsForUser() (+6 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (20): clampExpansion(), interpolate(), resumeDesignAtExpansion(), acronymTokenOf(), bankEntryCorpus(), breaksTie(), bulletClaimIsGrounded(), contentWords() (+12 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (7): decryptRow(), sendProfile(), assertEncryptionKeyConfigured(), decryptField(), encryptField(), FieldDecryptError, getKey()

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (18): completeEmailVerificationIfPresent(), safeContinueButton(), visibleOtpField(), waitForCode(), asRecord(), bodyText(), decodeBase64Url(), defaultExecutor() (+10 more)

### Community 9 - "Community 9"
Cohesion: 0.1
Nodes (5): fetchSourceJobs(), normalizeAshbyJobs(), normalizeGreenhouseJobs(), normalizeLeverJobs(), sourceEndpoint()

### Community 10 - "Community 10"
Cohesion: 0.22
Nodes (18): authorizationValidAtClick(), buildPacket(), claimPreparation(), claimSubmission(), discoverAndResolveQuestions(), fail(), holdRevokedSubmission(), loadApplicationProfileLike() (+10 more)

### Community 11 - "Community 11"
Cohesion: 0.23
Nodes (17): collectCurrencies(), currencyPrefixAt(), dedupeRanges(), detectCurrency(), findStatedRanges(), groupDigits(), isProseSalary(), mapCurrencyToken() (+9 more)

### Community 12 - "Community 12"
Cohesion: 0.15
Nodes (7): browserSessionBody(), config(), createBrowserSession(), getBrowserSession(), managedBrowserErrorMessage(), request(), runManagedBrowser()

### Community 13 - "Community 13"
Cohesion: 0.19
Nodes (7): extractRankedItems(), metricTokens(), numberSignatures(), numStr(), signaturesOf(), splitListSegment(), ungroundedNumbers()

### Community 14 - "Community 14"
Cohesion: 0.26
Nodes (5): createRateLimitHook(), defaultRateLimitConfig(), InMemoryRateLimitStore, policyForRequest(), positiveInteger()

### Community 15 - "Community 15"
Cohesion: 0.27
Nodes (6): buildContextBlock(), draftApplicationAnswer(), normalizeDraftedAnswer(), rankingGroundingFor(), rankingRuleText(), thinRankingWarning()

### Community 16 - "Community 16"
Cohesion: 0.27
Nodes (5): classifyField(), isLocationCommitmentQuestion(), isRefusedQuestion(), resolveKnownAnswer(), workEligibilitySkipReason()

### Community 17 - "Community 17"
Cohesion: 0.39
Nodes (7): annualize(), answerCompensation(), detectCurrency(), detectUnit(), formatCompensation(), parseStatedCompensation(), toNumber()

### Community 18 - "Community 18"
Cohesion: 0.67
Nodes (0):

### Community 19 - "Community 19"
Cohesion: 1.0
Nodes (0):

### Community 20 - "Community 20"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **Thin community `Community 19`** (1 nodes): `drizzle.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 20`** (1 nodes): `submissionStateMachine.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 6` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Community 7` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
