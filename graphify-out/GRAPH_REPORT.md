# Graph Report - .  (2026-07-21)

## Corpus Check
- 79 files · ~67,332 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 310 nodes · 555 edges · 15 communities detected
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
Nodes (11): decryptRow(), sendProfile(), buildVerificationEmail(), issuedBeforeEpoch(), requireAuth(), sendVerificationEmail(), assertEncryptionKeyConfigured(), decryptField() (+3 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (18): APOLLO_HEADERS(), apolloSearchIds(), fetchApolloContacts(), personaTitleBuckets(), learnPattern(), resolveEmail(), orderedPatterns(), renderTopCandidates() (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.15
Nodes (33): contactLine(), createResumeDocument(), drawEducation(), drawEntrySection(), drawSectionHeader(), drawSplitLine(), educationHeight(), educationPosition() (+25 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (7): clampExpansion(), interpolate(), resumeDesignAtExpansion(), generateResumeSpec(), normalizeSpec(), spec(), traecoSpec()

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (5): buildApp(), getApp(), handler(), start(), trustProxySetting()

### Community 5 - "Community 5"
Cohesion: 0.1
Nodes (6): buildContextBlock(), draftApplicationAnswer(), normalizeDraftedAnswer(), rankingGroundingFor(), rankingRuleText(), thinRankingWarning()

### Community 6 - "Community 6"
Cohesion: 0.24
Nodes (17): acronymTokenOf(), bankEntryCorpus(), breaksTie(), bulletClaimIsGrounded(), contentWords(), findGroundingViolations(), findUngroundedSkills(), jdKeywords() (+9 more)

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (4): bankEntriesFrom(), declaredSkillsList(), planBankReconciliation(), serveProfileJson()

### Community 8 - "Community 8"
Cohesion: 0.19
Nodes (7): extractRankedItems(), metricTokens(), numberSignatures(), numStr(), signaturesOf(), splitListSegment(), ungroundedNumbers()

### Community 9 - "Community 9"
Cohesion: 0.16
Nodes (5): allowHourly(), bumpCounter(), hourPeriod(), quotaExceededPayload(), upgradeUrl()

### Community 10 - "Community 10"
Cohesion: 0.26
Nodes (5): createRateLimitHook(), defaultRateLimitConfig(), InMemoryRateLimitStore, policyForRequest(), positiveInteger()

### Community 11 - "Community 11"
Cohesion: 0.31
Nodes (8): applyResumePolicy(), deriveCandidateContext(), metricCount(), orgScore(), overlapScore(), parseGraduationDate(), relevanceScore(), tokens()

### Community 12 - "Community 12"
Cohesion: 0.31
Nodes (7): deleteBlobsForUser(), getKey(), listAll(), mintDownloadToken(), readDownloadToken(), resumePrefix(), sweepExpiredResumeBlobs()

### Community 13 - "Community 13"
Cohesion: 0.67
Nodes (0):

### Community 14 - "Community 14"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **Thin community `Community 14`** (1 nodes): `drizzle.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 7` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._