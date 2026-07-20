# Graph Report - .  (2026-07-20)

## Corpus Check
- 66 files · ~54,018 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 218 nodes · 365 edges · 15 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `renderResumePdf()` - 6 edges
2. `matchBankEntry()` - 6 edges
3. `findGroundingViolations()` - 6 edges
4. `pruneUngroundedContent()` - 6 edges
5. `validateResumeSpec()` - 5 edges
6. `getKey()` - 4 edges
7. `signaturesOf()` - 4 edges
8. `ungroundedYears()` - 4 edges
9. `acronymTokenOf()` - 4 edges
10. `orgMatchScore()` - 4 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.09
Nodes (6): decryptRow(), sendProfile(), buildVerificationEmail(), issuedBeforeEpoch(), requireAuth(), sendVerificationEmail()

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (8): contactLine(), drawSectionHeader(), drawTabbedLine(), estimateHeight(), renderResumePdf(), trimSpecToFit(), generateResumeSpec(), normalizeSpec()

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (7): learnPattern(), resolveEmail(), orderedPatterns(), renderTopCandidates(), extractJobTitle(), extractTeam(), generateSyntheticContacts()

### Community 3 - "Community 3"
Cohesion: 0.13
Nodes (7): deleteBlobsForUser(), getKey(), listAll(), mintDownloadToken(), readDownloadToken(), resumePrefix(), sweepExpiredResumeBlobs()

### Community 4 - "Community 4"
Cohesion: 0.25
Nodes (16): acronymTokenOf(), bankEntryCorpus(), breaksTie(), contentWords(), findGroundingViolations(), findUngroundedSkills(), jdKeywords(), matchBankEntry() (+8 more)

### Community 5 - "Community 5"
Cohesion: 0.14
Nodes (2): declaredSkillsList(), serveProfileJson()

### Community 6 - "Community 6"
Cohesion: 0.23
Nodes (11): APOLLO_HEADERS(), apolloSearchIds(), fetchApolloContacts(), personaTitleBuckets(), aliasGroupOf(), collapseInitialisms(), isAlumniMatch(), normalizeString() (+3 more)

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (4): buildApp(), getApp(), handler(), start()

### Community 8 - "Community 8"
Cohesion: 0.17
Nodes (5): assertEncryptionKeyConfigured(), decryptField(), encryptField(), FieldDecryptError, getKey()

### Community 9 - "Community 9"
Cohesion: 0.22
Nodes (3): allowHourly(), bumpCounter(), hourPeriod()

### Community 10 - "Community 10"
Cohesion: 0.31
Nodes (5): metricTokens(), numberSignatures(), numStr(), signaturesOf(), ungroundedNumbers()

### Community 11 - "Community 11"
Cohesion: 0.33
Nodes (3): buildContextBlock(), draftApplicationAnswer(), normalizeDraftedAnswer()

### Community 12 - "Community 12"
Cohesion: 0.67
Nodes (2): spec(), traecoSpec()

### Community 13 - "Community 13"
Cohesion: 1.0
Nodes (0):

### Community 14 - "Community 14"
Cohesion: 1.0
Nodes (0):

## Knowledge Gaps
- **Thin community `Community 13`** (2 nodes): `index.test.ts`, `getApp()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 14`** (1 nodes): `drizzle.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._