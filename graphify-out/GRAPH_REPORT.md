# Graph Report - .  (2026-07-22)

## Corpus Check
- 87 files · ~74,051 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 361 nodes · 659 edges · 18 communities detected
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
Cohesion: 0.06
Nodes (7): deriveEditedTerms(), overlapScore(), terms(), generateResumeSpec(), normalizeSpec(), spec(), traecoSpec()

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (33): contactLine(), createResumeDocument(), drawEducation(), drawEntrySection(), drawSectionHeader(), drawSplitLine(), educationHeight(), educationPosition() (+25 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (11): buildVerificationEmail(), hashCode(), issuedBeforeEpoch(), requireAuth(), sendVerificationEmail(), verificationFailure(), verificationSender(), bankEntriesFrom() (+3 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (10): buildApp(), getApp(), handler(), start(), trustProxySetting(), allowHourly(), bumpCounter(), hourPeriod() (+2 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (20): clampExpansion(), interpolate(), resumeDesignAtExpansion(), acronymTokenOf(), bankEntryCorpus(), breaksTie(), bulletClaimIsGrounded(), contentWords() (+12 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (11): APOLLO_HEADERS(), apolloSearchIds(), fetchApolloContacts(), personaTitleBuckets(), learnPattern(), resolveEmail(), orderedPatterns(), renderTopCandidates() (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (7): decryptRow(), sendProfile(), assertEncryptionKeyConfigured(), decryptField(), encryptField(), FieldDecryptError, getKey()

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (7): deleteBlobsForUser(), getKey(), listAll(), mintDownloadToken(), readDownloadToken(), resumePrefix(), sweepExpiredResumeBlobs()

### Community 8 - "Community 8"
Cohesion: 0.19
Nodes (7): extractRankedItems(), metricTokens(), numberSignatures(), numStr(), signaturesOf(), splitListSegment(), ungroundedNumbers()

### Community 9 - "Community 9"
Cohesion: 0.26
Nodes (5): createRateLimitHook(), defaultRateLimitConfig(), InMemoryRateLimitStore, policyForRequest(), positiveInteger()

### Community 10 - "Community 10"
Cohesion: 0.22
Nodes (5): browserSessionBody(), config(), createBrowserSession(), getBrowserSession(), request()

### Community 11 - "Community 11"
Cohesion: 0.23
Nodes (9): buildManagedPortalActions(), fillFirst(), fillPortal(), fillReviewedQuestions(), managedFill(), readManagedReceipt(), readReceipt(), receiptReference() (+1 more)

### Community 12 - "Community 12"
Cohesion: 0.31
Nodes (8): applyResumePolicy(), deriveCandidateContext(), metricCount(), orgScore(), overlapScore(), parseGraduationDate(), relevanceScore(), tokens()

### Community 13 - "Community 13"
Cohesion: 0.53
Nodes (8): buildPacket(), fail(), nextReview(), prepare(), prepareManaged(), processSubmissionApplication(), submit(), writeReview()

### Community 14 - "Community 14"
Cohesion: 0.39
Nodes (6): buildContextBlock(), draftApplicationAnswer(), normalizeDraftedAnswer(), rankingGroundingFor(), rankingRuleText(), thinRankingWarning()

### Community 15 - "Community 15"
Cohesion: 0.47
Nodes (7): aliasGroupOf(), collapseInitialisms(), isAlumniMatch(), normalizeString(), parseSchool(), sameInstitutionByTokens(), tokenize()

### Community 16 - "Community 16"
Cohesion: 0.67
Nodes (0):

### Community 17 - "Community 17"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **Thin community `Community 17`** (1 nodes): `drizzle.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 6` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 7` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._