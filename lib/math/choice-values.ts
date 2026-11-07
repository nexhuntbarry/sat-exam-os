// lib/math/choice-values.ts
//
// Turn printed answer choices ("$\\frac{3}{8}$", "5,500", "120.00%") into
// numbers and map a computed value to the one choice that matches. Pure, no
// AI. Used by lib/verify-ai-key.ts (code-checked solve) and
// lib/explanation-consistency.ts (does the explanation's number match the key).

import { nearlyEqual, tryEvaluate } from "@/lib/math/safe-eval";

export type ChoiceLike = { label?: string; text?: string | null; image_url?: string | null };

/** LaTeX / plain choice text → arithmetic expression for safe-eval (null = not a plain value). */
export function latexToExpr(text: string): string | null {
  let s = (text ?? "").trim();
  if (!s) return null;
  s = s.replace(/\$/g, "").replace(/\\left|\\right|\\displaystyle|\\,|\\!|\\;/g, "").replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, "$1");
  // A mixed number ("3\frac{3}{5}" = 3.6): a whole number directly before a
  // numeric fraction is added, not multiplied.
  s = s.replace(/(?<![\d.^])(\d+)\s*\\[dt]?frac\{\s*(\d+)\s*\}\{\s*(\d+)\s*\}/g, "(($1)+(($2)/($3)))");
  // Innermost first, so \frac{\sqrt{3}}{2} and \sqrt{\frac{1}{4}} both resolve.
  for (let i = 0; i < 8 && /\\(?:[dt]?frac|sqrt)/.test(s); i++) {
    s = s
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
      .replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, "(($2)^(1/($1)))")
      .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  }
  s = s
    .replace(/\^\{([^{}]*)\}/g, "^($1)")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\pi/g, "pi")
    .replace(/[{}]/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\\%|%/g, "")
    .replace(/\s+/g, "");
  if (/\\|[a-oq-zA-Z_]/.test(s.replace(/sqrt|pi/g, ""))) return null; // a variable / word: not a plain value
  // Implicit multiplication: 2sqrt(3), 3pi, 2(4), )(.
  s = s.replace(/(\d|\))(?=sqrt|pi|\()/g, "$1*");
  return s || null;
}

export function choiceValue(text: string | null | undefined): number | null {
  const e = latexToExpr(text ?? "");
  return e ? tryEvaluate(e) : null;
}

/** Decimals printed in a choice (2 for "51.12") — sets the matching tolerance. */
export function printedDecimals(text: string): number {
  const m = text.match(/\d\.(\d+)/);
  return m ? m[1].length : 0;
}

/** The one choice whose value equals `value` (null = none or ambiguous, or choices aren't values). */
export function mapValueToChoice(value: number, choices: ChoiceLike[]): string | null {
  const vals = choices.map((c) => ({ label: (c.label ?? "").toUpperCase(), text: c.text ?? "", v: c.image_url ? null : choiceValue(c.text) }));
  if (vals.length === 0 || vals.some((c) => c.v === null)) return null;
  const hits = vals.filter((c) => {
    const d = printedDecimals(c.text);
    return nearlyEqual(c.v as number, value, 1e-6) || (d > 0 && Math.abs((c.v as number) - value) <= 0.5 * 10 ** -d + 1e-12);
  });
  return hits.length === 1 ? hits[0].label : null;
}
