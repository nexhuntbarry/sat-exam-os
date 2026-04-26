// ────────────────────────────────────────────
// normalizeMath — auto-wrap legacy / loosely-formatted math in $...$
//
// Older parsed questions pre-date the strict "always use $...$" extraction
// rule, so plain `\frac{1}{2}` or `1/7` shows up raw and breaks the math
// rendering. This helper conservatively wraps obvious math fragments so they
// render through KaTeX, while leaving prose, URLs, and code blocks alone.
//
// Idempotent: never double-wraps. Skips spans already inside $...$, $$...$$,
// inline `…` code, fenced ```…``` blocks, and URLs.
// ────────────────────────────────────────────

const PROTECTED_PATTERN = new RegExp(
  [
    "```[\\s\\S]*?```", // fenced code blocks
    "`[^`\\n]*`", // inline code
    "\\$\\$[\\s\\S]*?\\$\\$", // display math
    "\\$[^\\$\\n]*\\$", // inline math
    "https?:\\/\\/\\S+", // URLs
  ].join("|"),
  "g",
);

const PLACEHOLDER_PREFIX = "\u0000NMATH";

interface SegmentSplit {
  parts: string[];
  protectedSpans: string[];
}

function splitProtected(input: string): SegmentSplit {
  const protectedSpans: string[] = [];
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of input.matchAll(PROTECTED_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) parts.push(input.slice(lastIndex, start));
    parts.push(`${PLACEHOLDER_PREFIX}${protectedSpans.length}\u0000`);
    protectedSpans.push(match[0]);
    lastIndex = start + match[0].length;
  }
  if (lastIndex < input.length) parts.push(input.slice(lastIndex));
  return { parts, protectedSpans };
}

function restoreProtected(text: string, spans: string[]): string {
  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)\\u0000`, "g"),
    (_m, idx) => spans[Number(idx)] ?? "",
  );
}

// Wrap balanced \frac{...}{...} and \sqrt{...} (handles nested {}).
function wrapBalancedCommand(text: string, command: string, argCount: number): string {
  const cmd = `\\${command}`;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(cmd, i);
    if (idx === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, idx);
    let cursor = idx + cmd.length;
    let parsedAll = true;
    for (let a = 0; a < argCount; a++) {
      while (cursor < text.length && text[cursor] === " ") cursor++;
      if (text[cursor] !== "{") {
        parsedAll = false;
        break;
      }
      let depth = 1;
      cursor++;
      while (cursor < text.length && depth > 0) {
        const ch = text[cursor];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        cursor++;
      }
      if (depth !== 0) {
        parsedAll = false;
        break;
      }
    }
    if (!parsedAll) {
      out += text.slice(idx, idx + cmd.length);
      i = idx + cmd.length;
      continue;
    }
    const fragment = text.slice(idx, cursor);
    out += `$${fragment}$`;
    i = cursor;
  }
  return out;
}

const STANDALONE_LATEX_TOKENS = [
  "\\sum",
  "\\int",
  "\\prod",
  "\\pi",
  "\\theta",
  "\\alpha",
  "\\beta",
  "\\gamma",
  "\\delta",
  "\\lambda",
  "\\mu",
  "\\sigma",
  "\\omega",
  "\\infty",
];

function wrapStandaloneTokens(text: string): string {
  let out = text;
  for (const token of STANDALONE_LATEX_TOKENS) {
    const escaped = token.replace(/\\/g, "\\\\");
    const re = new RegExp(`(${escaped})(?![a-zA-Z])`, "g");
    out = out.replace(re, "$$$1$$");
  }
  return out;
}

// Wrap standalone integer fractions like `1/7` (but not `2024/01/15` dates,
// `a/b` variables, or `1/7th`). Require digits on both sides surrounded by
// non-word chars and not adjacent to another `/`.
function wrapSimpleFractions(text: string): string {
  return text.replace(
    /(^|[\s(=,])(\d+\/\d+)(?=$|[\s).,;:!?])/g,
    (_m, lead, frac) => `${lead}$${frac}$`,
  );
}

// Wrap simple exponents like `x^2`, `x^{2}`, `n^10`.
function wrapExponents(text: string): string {
  return text.replace(
    /(^|[\s(=,])([A-Za-z0-9]\^(?:\{[^}\n]+\}|[A-Za-z0-9]+))(?=$|[\s).,;:!?])/g,
    (_m, lead, expr) => `${lead}$${expr}$`,
  );
}

export function normalizeMath(text: string): string {
  if (!text) return text;
  const { parts, protectedSpans } = splitProtected(text);
  const transformed = parts
    .map((part) => {
      if (part.startsWith(PLACEHOLDER_PREFIX)) return part;
      let p = part;
      p = wrapBalancedCommand(p, "frac", 2);
      p = wrapBalancedCommand(p, "sqrt", 1);
      p = wrapStandaloneTokens(p);
      p = wrapSimpleFractions(p);
      p = wrapExponents(p);
      return p;
    })
    .join("");
  return restoreProtected(transformed, protectedSpans);
}
