# Graph Report - .  (2026-07-25)

## Corpus Check
- 102 files · ~88,466 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 417 nodes · 753 edges · 21 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `measureResumeLayout()` - 14 edges
2. `usableWidth()` - 11 edges
3. `planResumeLayout()` - 9 edges
4. `renderResumePdf()` - 9 edges
5. `InMemoryRateLimitStore` - 7 edges
6. `textHeight()` - 7 edges
7. `resumeContentBlocks()` - 7 edges
8. `educationHeight()` - 7 edges
9. `findGroundingViolations()` - 7 edges
10. `draftApplicationAnswer()` - 6 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (7): deriveEditedTerms(), overlapScore(), terms(), generateResumeSpec(), normalizeSpec(), spec(), traecoSpec()

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (18): APOLLO_HEADERS(), apolloSearchIds(), fetchApolloContacts(), personaTitleBuckets(), learnPattern(), resolveEmail(), orderedPatterns(), renderTopCandidates() (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (11): buildVerificationEmail(), hashCode(), issuedBeforeEpoch(), requireAuth(), sendVerificationEmail(), verificationFailure(), verificationSender(), bankEntriesFrom() (+3 more)

### Community 3 - "Community 3"
Cohesion: 0.15
Nodes (33): contactLine(), createResumeDocument(), drawEducation(), drawEntrySection(), drawSectionHeader(), drawSplitLine(), educationHeight(), educationPosition() (+25 more)

### Community 4 - "Community 4"
Cohesion: 0.08
Nodes (10): buildApp(), getApp(), handler(), start(), trustProxySetting(), allowHourly(), bumpCounter(), hourPeriod() (+2 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (7): decryptRow(), sendProfile(), assertEncryptionKeyConfigured(), decryptField(), encryptField(), FieldDecryptError, getKey()

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (6): buildContextBlock(), draftApplicationAnswer(), normalizeDraftedAnswer(), rankingGroundingFor(), rankingRuleText(), thinRankingWarning()

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (7): deleteBlobsForUser(), getKey(), listAll(), mintDownloadToken(), readDownloadToken(), resumePrefix(), sweepExpiredResumeBlobs()

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (12): buildManagedPortalActions(), canFillReviewedQuestions(), fillFirst(), fillPortal(), fillReviewedQuestions(), managedFill(), managedUpload(), readManagedReceipt() (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.24
Nodes (17): acronymTokenOf(), bankEntryCorpus(), breaksTie(), bulletClaimIsGrounded(), contentWords(), findGroundingViolations(), findUngroundedSkills(), jdKeywords() (+9 more)

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (7): browserSessionBody(), config(), createBrowserSession(), getBrowserSession(), managedBrowserErrorMessage(), request(), runManagedBrowser()

### Community 11 - "Community 11"
Cohesion: 0.18
Nodes (5): fetchSourceJobs(), normalizeAshbyJobs(), normalizeGreenhouseJobs(), normalizeLeverJobs(), sourceEndpoint()

### Community 12 - "Community 12"
Cohesion: 0.19
Nodes (7): extractRankedItems(), metricTokens(), numberSignatures(), numStr(), signaturesOf(), splitListSegment(), ungroundedNumbers()

### Community 13 - "Community 13"
Cohesion: 0.26
Nodes (5): createRateLimitHook(), defaultRateLimitConfig(), InMemoryRateLimitStore, policyForRequest(), positiveInteger()

### Community 14 - "Community 14"
Cohesion: 0.33
Nodes (9): applyResumePolicy(), deriveCandidateContext(), metricCount(), orgScore(), overlapScore(), parseGraduationDate(), relevanceScore(), resumeSafeTargetRole() (+1 more)

### Community 15 - "Community 15"
Cohesion: 0.53
Nodes (8): buildPacket(), fail(), nextReview(), prepare(), prepareManaged(), processSubmissionApplication(), submit(), writeReview()

### Community 16 - "Community 16"
Cohesion: 0.39
Nodes (7): annualize(), answerCompensation(), detectCurrency(), detectUnit(), formatCompensation(), parseStatedCompensation(), toNumber()

### Community 17 - "Community 17"
Cohesion: 0.54
Nodes (6): describeRequiredBlocker(), describeUnlabelledBlockers(), humanFieldLabel(), isOpaqueIdentifier(), sanitizeProviderBlockers(), tidyLabel()

### Community 18 - "Community 18"
Cohesion: 1.0
Nodes (3): clampExpansion(), interpolate(), resumeDesignAtExpansion()

### Community 19 - "Community 19"
Cohesion: 0.67
Nodes (0):

### Community 20 - "Community 20"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **Thin community `Community 20`** (1 nodes): `drizzle.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 6` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `Community 7` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._