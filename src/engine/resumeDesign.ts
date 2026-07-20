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
    sparseTriggerRatio: number;
    targetFillRatio: number;
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
  density: {
    sparseTriggerRatio: 0.5,
    targetFillRatio: 0.66,
    maximumFillRatio: 1,
  },
  limits: {
    maxBulletLines: 2,
  },
};

const SPACIOUS_DESIGN: ResumeDesignTokens = {
  ...COMPACT_DESIGN,
  typography: {
    name: 19,
    contact: 10.5,
    section: 11.5,
    body: 11.5,
    lineGapRatio: { ...COMPACT_DESIGN.typography.lineGapRatio },
  },
  spacing: {
    ...COMPACT_DESIGN.spacing,
    contactTop: 4,
    headerBottom: 12,
    educationTop: 8,
    sectionTop: 16,
    sectionRuleAfter: 9,
    entryTop: 10,
    detailTop: 3,
    bulletTop: 4,
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
