// lib/sat-skills.ts
//
// The official digital SAT content domains and their 30 skills (College
// Board: 11 Reading & Writing, 19 Math), with the official question share
// per domain, and canonicalSkill(): maps the free-text skill labels the
// parser stores (247 spellings in prod, 2026-11-14) onto one official
// skill. A label we can't place confidently goes to "Other (<domain>)".
// The official skill's domain wins over the stored domain (e.g. 29 "Words
// in Context" questions are filed under Information and Ideas; Words in
// Context is a Craft and Structure skill) — Premier, 2026-11-17 (plan Q8).
// Pure; used by the Custom test pool and selector (lib/custom-test).

export type SatSection = "Reading & Writing" | "Math";

export interface SatDomain {
  section: SatSection;
  name: string;
  /** Official share of the section's questions, percent. */
  weight: number;
  skills: string[];
}

export const SAT_DOMAINS: SatDomain[] = [
  {
    section: "Reading & Writing",
    name: "Information and Ideas",
    weight: 26,
    skills: ["Central Ideas and Details", "Command of Evidence: Textual", "Command of Evidence: Quantitative", "Inferences"],
  },
  {
    section: "Reading & Writing",
    name: "Craft and Structure",
    weight: 28,
    skills: ["Words in Context", "Text Structure and Purpose", "Cross-Text Connections"],
  },
  { section: "Reading & Writing", name: "Expression of Ideas", weight: 20, skills: ["Rhetorical Synthesis", "Transitions"] },
  {
    section: "Reading & Writing",
    name: "Standard English Conventions",
    weight: 26,
    skills: ["Boundaries", "Form, Structure, and Sense"],
  },
  {
    section: "Math",
    name: "Algebra",
    weight: 35,
    skills: [
      "Linear equations in one variable",
      "Linear functions",
      "Linear equations in two variables",
      "Systems of two linear equations in two variables",
      "Linear inequalities in one or two variables",
    ],
  },
  {
    section: "Math",
    name: "Advanced Math",
    weight: 35,
    skills: [
      "Equivalent expressions",
      "Nonlinear equations in one variable and systems of equations in two variables",
      "Nonlinear functions",
    ],
  },
  {
    section: "Math",
    name: "Problem-Solving and Data Analysis",
    weight: 15,
    skills: [
      "Ratios, rates, proportional relationships, and units",
      "Percentages",
      "One-variable data: distributions and measures of center and spread",
      "Two-variable data: models and scatterplots",
      "Probability and conditional probability",
      "Inference from sample statistics and margin of error",
      "Evaluating statistical claims: observational studies and experiments",
    ],
  },
  {
    section: "Math",
    name: "Geometry and Trigonometry",
    weight: 15,
    skills: ["Area and volume", "Lines, angles, and triangles", "Right triangles and trigonometry", "Circles"],
  },
];

/** "Other (<domain>)": a question whose skill label couldn't be placed. */
export function otherSkill(domain: string): string {
  return `Other (${domain})`;
}

export function isOtherSkill(skill: string): boolean {
  return /^Other \(.+\)$/.test(skill);
}

export function domainsOf(section: SatSection): SatDomain[] {
  return SAT_DOMAINS.filter((d) => d.section === section);
}

export function sectionOfDomain(domain: string): SatSection | null {
  return SAT_DOMAINS.find((d) => d.name === domain)?.section ?? null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();

/** Stored domain spellings → official domain name. */
const DOMAIN_ALIASES: Record<string, string> = {
  "information and ideas": "Information and Ideas",
  "craft and structure": "Craft and Structure",
  "expression of ideas": "Expression of Ideas",
  "standard english conventions": "Standard English Conventions",
  algebra: "Algebra",
  "advanced math": "Advanced Math",
  "problem solving and data analysis": "Problem-Solving and Data Analysis",
  "problem-solving and data analysis": "Problem-Solving and Data Analysis",
  "geometry and trigonometry": "Geometry and Trigonometry",
};

/** The official domain for a stored domain label, or null. */
export function officialDomain(stored: string | null | undefined): string | null {
  return stored ? DOMAIN_ALIASES[norm(stored)] ?? null : null;
}

const OFFICIAL_BY_NORM = new Map<string, { section: SatSection; domain: string; skill: string }>();
for (const d of SAT_DOMAINS) for (const s of d.skills) OFFICIAL_BY_NORM.set(norm(s), { section: d.section, domain: d.name, skill: s });

function official(skill: string): { domain: string; skill: string } {
  const hit = OFFICIAL_BY_NORM.get(norm(skill));
  if (!hit) throw new Error(`not an official skill: ${skill}`);
  return { domain: hit.domain, skill: hit.skill };
}

// Ordered keyword rules per section: first match wins. Each was checked
// against every label in prod (see .omc/qa/unit/custom-test-skills.test.ts).
type Rule = [RegExp, string];
const RW_RULES: Rule[] = [
  [/^command of evidence[^a-z]*quantitative|quantitative evidence/, "Command of Evidence: Quantitative"],
  [/^command of evidence[^a-z]*textual|^textual evidence/, "Command of Evidence: Textual"],
  [/central ideas|main idea|key details/, "Central Ideas and Details"],
  [/^inferences?$/, "Inferences"],
  [/words? in context|vocabulary/, "Words in Context"],
  [/text structure|structure and purpose/, "Text Structure and Purpose"],
  [/cross-text/, "Cross-Text Connections"],
  [/rhetorical synthesis/, "Rhetorical Synthesis"],
  [/^transitions?$/, "Transitions"],
  [/boundar|punctuation|sentence structure|subordination|coordination/, "Boundaries"],
  [/form, structure|agreement|pronoun|verb|possessive|plural|participial|modifier|^grammar|usage/, "Form, Structure, and Sense"],
];
const MATH_RULES: Rule[] = [
  // Problem-Solving and Data Analysis
  [/probabilit|two-way table/, "Probability and conditional probability"],
  [/margin of error|inference|sampl/, "Inference from sample statistics and margin of error"],
  [/observational|experiment|statistical claim/, "Evaluating statistical claims: observational studies and experiments"],
  [/scatter|best fit|two-variable data|^linear models|linear and nonlinear models/, "Two-variable data: models and scatterplots"],
  [/mean|median|mode\b|standard deviation|center|spread|^statistic|statistical measures|data and statistics|one-variable data/, "One-variable data: distributions and measures of center and spread"],
  [/percent/, "Percentages"],
  // Geometry and Trigonometry (before ratios: "similar triangles and proportional reasoning")
  [/radian|unit circle|inscribed|tangent line|^circles?\b|circle/, "Circles"],
  [/trigonometr|right triangle|pythag|special right/, "Right triangles and trigonometry"],
  [/area|volume|surface|perimeter|scale and area/, "Area and volume"],
  [/triang|angle|^lines,|parallel|transversal|congruen|similar/, "Lines, angles, and triangles"],
  [/\bratios?\b|\brates?\b|proportion|unit conversion|unit analysis|mixture/, "Ratios, rates, proportional relationships, and units"],
  // Advanced Math
  [/equivalent expressions|polynomial (operations|expressions|division|factor)|operations with polynomials|factoring|simplifying rational|partial fractions|radicals and rational exponents|isolating a variable|solving for a variable/, "Equivalent expressions"],
  [/quadratic|nonlinear|polynomial|radical|rational|exponential|absolute value|zeros of|composite/, "__nonlinear__"],
  // Algebra
  [/inequalit/, "Linear inequalities in one or two variables"],
  [/system/, "__system__"],
  [/linear equations? in one variable|infinitely many solutions/, "Linear equations in one variable"],
  [/linear equations? in two (or more )?variables|linear equations and (slope|their graphs)/, "Linear equations in two variables"],
  [/^linear functions?|evaluating linear/, "Linear functions"],
];

/**
 * The official domain + skill for a stored (section, domain, skill), or
 * `Other (<domain>)` under the stored domain when the label can't be
 * placed. `hint.quantitative`: the question has a table or graph (used for
 * the generic "Command of Evidence" label).
 */
export function canonicalSkill(
  section: string | null | undefined,
  domain: string | null | undefined,
  skill: string | null | undefined,
  hint: { quantitative?: boolean } = {},
): { domain: string; skill: string } {
  const storedDomain = officialDomain(domain) ?? (domain ?? "").trim();
  const label = norm(skill ?? "");
  const other = { domain: storedDomain, skill: otherSkill(storedDomain || "Unknown") };
  if (!label) return other;
  const exact = OFFICIAL_BY_NORM.get(label);
  if (exact) return { domain: exact.domain, skill: exact.skill };
  const isMath = section === "Math" || sectionOfDomain(storedDomain) === "Math";
  if (!isMath) {
    if (/^command of evidence$/.test(label)) {
      return official(hint.quantitative ? "Command of Evidence: Quantitative" : "Command of Evidence: Textual");
    }
    for (const [re, target] of RW_RULES) if (re.test(label)) return official(target);
    return other;
  }
  // Generic labels the stored domain decides.
  if (label === "evaluating functions" || label === "functions" || label === "function properties" || label === "graphs of functions" || /^interpreting (functions|function graphs)/.test(label) || label === "transformations of functions") {
    if (storedDomain === "Advanced Math") return official("Nonlinear functions");
    if (storedDomain === "Algebra") return official("Linear functions");
    return other;
  }
  for (const [re, target] of MATH_RULES) {
    if (!re.test(label)) continue;
    if (target === "__nonlinear__") {
      if (/function|graph|growth|decay|transformation/.test(label) && !/equation/.test(label)) return official("Nonlinear functions");
      if (/expression/.test(label) && !/equation/.test(label)) return official("Equivalent expressions");
      return official("Nonlinear equations in one variable and systems of equations in two variables");
    }
    if (target === "__system__") {
      if (/nonlinear|quadratic/.test(label)) return official("Nonlinear equations in one variable and systems of equations in two variables");
      if (/linear/.test(label) || storedDomain === "Algebra") return official("Systems of two linear equations in two variables");
      if (storedDomain === "Advanced Math") return official("Nonlinear equations in one variable and systems of equations in two variables");
      return other;
    }
    return official(target);
  }
  return other;
}
