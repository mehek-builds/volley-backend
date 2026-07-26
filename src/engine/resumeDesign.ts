export interface ResumeDesignTokens {
  page: {
    width: number;
    height: number;
    margin: number;
  };
  typography: {
    name: number;
    contact: number;
    section: number;
    body: number;
    lineGapRatio: {
      regular: number;
      bold: number;
      italic: number;
    };
  };
  spacing: {
    contactTop: number;
    headerBottom: number;
    educationTop: number;
    sectionTop: number;
    sectionRuleBefore: number;
    sectionRuleAfter: number;
    entryTop: number;
    detailTop: number;
    bulletTop: number;
    bulletIndent: number;
  };
  geometry: {
    splitLeftRatio: number;
    splitRightRatio: number;
    sectionRuleWidth: number;
  };
  density: {
    /** Below this after expansion, the resume is reported as genuinely thin. WARNING ONLY. */
    sparseTriggerRatio: number;
    /** Compact layouts below this fill get expanded. Above it, compact is already full enough. */
    expandBelowRatio: number;
    /** What the expansion search aims for. */
    targetFillRatio: number;
    /** Hard ceiling: past this the content would overflow the page. */
    maximumFillRatio: number;
  };
  limits: {
    maxBulletLines: number;
  };
}

const COMPACT_DESIGN: ResumeDesignTokens = {
  page: {
    width: 612,
    height: 792,
    margin: 36,
  },
  typography: {
    name: 16,
    contact: 9.5,
    section: 10.5,
    body: 10.5,
    lineGapRatio: {
      regular: -0.03390234375,
      bold: 0.00309765625,
      italic: -0.04990234375,
    },
  },
  spacing: {
    contactTop: 2,
    headerBottom: 4,
    educationTop: 2,
    sectionTop: 7,
    sectionRuleBefore: 1,
    sectionRuleAfter: 4,
    entryTop: 3,
    detailTop: 1,
    bulletTop: 1,
    bulletIndent: 10,
  },
  geometry: {
    splitLeftRatio: 0.72,
    splitRightRatio: 0.27,
    sectionRuleWidth: 0.65,
  },
  /* Revised 2026-07-27, after a five-resume end-to-end run measured real output at 0.675 to 0.720
   * fill: every generated resume was leaving roughly a third of the page blank, and a resume that
   * stops two thirds down reads as a thin candidate however good the content is.
   *
   * The old numbers only ever expanded a layout that came in under 50% fill, and even then aimed
   * at 66%. So a typical student resume short-circuited to compact and was never expanded at all.
   * expandBelowRatio now separates "should we expand" from sparseTriggerRatio's "is this
   * genuinely too thin to report", which were previously the same number doing two jobs.
   *
   * Nothing here can overflow the page: layoutAcceptsExpansion() bounds every candidate by
   * maximumFillRatio and the per-bullet line limit, so the search can only pick a layout that
   * still fits on one page. */
  density: {
    sparseTriggerRatio: 0.5,
    expandBelowRatio: 0.98,
    targetFillRatio: 0.94,
    maximumFillRatio: 1,
  },
  limits: {
    maxBulletLines: 2,
  },
};

/* The open end of the scale. Widened 2026-07-27: the previous values topped out around 0.78 fill
 * for an ordinary student resume, so the expansion search would run to expansion=1 and still leave
 * a fifth of the page blank - it had nowhere further to go. These give the search enough range to
 * actually reach targetFillRatio on a normal resume.
 *
 * Widening the ceiling does NOT make normal resumes airy: the search is a binary search for the
 * target, so a resume that reaches 0.94 at expansion 0.4 stops at 0.4. Only content that cannot
 * fill the page any other way ever sees these values, and for that content the alternative is
 * white space, not tighter typography. */
const SPACIOUS_DESIGN: ResumeDesignTokens = {
  ...COMPACT_DESIGN,
  typography: {
    name: 21,
    contact: 11,
    section: 12,
    body: 12,
    lineGapRatio: { ...COMPACT_DESIGN.typography.lineGapRatio },
  },
  spacing: {
    ...COMPACT_DESIGN.spacing,
    contactTop: 6,
    headerBottom: 22,
    educationTop: 14,
    sectionTop: 28,
    sectionRuleAfter: 12,
    entryTop: 19,
    detailTop: 5,
    bulletTop: 8,
  },
};

export const RESUME_DESIGN = {
  compact: COMPACT_DESIGN,
  spacious: SPACIOUS_DESIGN,
} as const;

function clampExpansion(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(start: number, end: number, expansion: number): number {
  return start + (end - start) * clampExpansion(expansion);
}

export function resumeDesignAtExpansion(expansion: number): ResumeDesignTokens {
  const amount = clampExpansion(expansion);
  const compact = RESUME_DESIGN.compact;
  const spacious = RESUME_DESIGN.spacious;

  return {
    page: { ...compact.page },
    typography: {
      name: interpolate(compact.typography.name, spacious.typography.name, amount),
      contact: interpolate(compact.typography.contact, spacious.typography.contact, amount),
      section: interpolate(compact.typography.section, spacious.typography.section, amount),
      body: interpolate(compact.typography.body, spacious.typography.body, amount),
      lineGapRatio: { ...compact.typography.lineGapRatio },
    },
    spacing: {
      contactTop: interpolate(compact.spacing.contactTop, spacious.spacing.contactTop, amount),
      headerBottom: interpolate(compact.spacing.headerBottom, spacious.spacing.headerBottom, amount),
      educationTop: interpolate(compact.spacing.educationTop, spacious.spacing.educationTop, amount),
      sectionTop: interpolate(compact.spacing.sectionTop, spacious.spacing.sectionTop, amount),
      sectionRuleBefore: compact.spacing.sectionRuleBefore,
      sectionRuleAfter: interpolate(compact.spacing.sectionRuleAfter, spacious.spacing.sectionRuleAfter, amount),
      entryTop: interpolate(compact.spacing.entryTop, spacious.spacing.entryTop, amount),
      detailTop: interpolate(compact.spacing.detailTop, spacious.spacing.detailTop, amount),
      bulletTop: interpolate(compact.spacing.bulletTop, spacious.spacing.bulletTop, amount),
      bulletIndent: compact.spacing.bulletIndent,
    },
    geometry: { ...compact.geometry },
    density: { ...compact.density },
    limits: { ...compact.limits },
  };
}
