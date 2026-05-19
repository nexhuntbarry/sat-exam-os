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

// Currency-handling: two stored variants need normalising before
// remark-math sees them, otherwise stray `$` glyphs end up paired into
// math regions that swallow whole paragraphs of prose into italic KaTeX.
//
// 1. `$\$NNN$` — parser-wrapped currency-as-math. remark-math 6 closes
//    the math run at the `$` *inside* `\$` (backslash doesn't escape
//    the delimiter for its scanner) so the trailing `$` of the wrapper
//    becomes an opener for whatever comes next. Strip the wrapper and
//    keep the markdown-literal `\$` so currency renders as plain "$".
//
// 2. Bare `$NNN` (no escape, no wrapper) — older parses skipped the
//    currency rule entirely. Each bare `$` followed by a sentence-final
//    digit becomes one half of a phantom math pair when another
//    currency `$` shows up later in the paragraph. We detect "currency
//    shaped" — `$` then a number then a non-math boundary (whitespace,
//    sentence punctuation, end of string) — and escape it. Leaves real
//    math like `$2x+1=5$` alone because those follow with operators or
//    letters, which are NOT in the currency boundary set.
function unwrapMathCurrency(text: string): string {
  return text.replace(/\$\\\$([0-9][\d,.]*)\$/g, (_m, num) => `\\$${num}`);
}

function escapeBareCurrency(text: string): string {
  return text.replace(
    // Lookbehind: must NOT be preceded by `\` (already escaped) or `$`
    //   (would be inside `$$..$$` display math we want to leave alone).
    // Number: 1+ digits with optional thousands grouping and decimal.
    // Lookahead: a sentence-boundary character or end-of-string —
    //   excludes digits/letters/operators that signal real math.
    /(^|[^\\$])\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?=[\s,.;:!?)\]}'"”’—–-]|$)/g,
    (_m, lead, num) => `${lead}\\$${num}`,
  );
}

// Collapse orphan `{,}` thin-space marks left behind when the AI
// thought it was emitting math but skipped the `$...$` wrap (so
// `1{,}150` lands as literal text instead of rendering as `1,150`).
// Safe globally: `{,}` is only meaningful inside a math context, and
// `1,150` renders identically once it's back inside math.
function collapseOrphanThinSpace(text: string): string {
  return text.replace(/\{,\}/g, ",");
}

// AI parser failure mode (Q12 Oct 2024 SAT Math):
// stores choices like `$950 + 50(t - 2) = 1{,}150$` (bare bookend
// dollars) or `\$950 + 50(t - 2) = 1{,}150\$` (escaped bookends).
// Either way the AI's intent was a math wrap but the bookend looks
// like currency, so the downstream escapeBareCurrency step rewrote
// the leading `$<digits>` as `\$<digits>` and the trailing `$` ended
// up dangling — the whole thing rendered as literal text.
//
// Fix: if a WHOLE string is bookended by either bare `$` or escaped
// `\$` AND the interior contains an `=` AND an algebraic operator
// or variable letter, treat it as a math wrap. Normalize to a clean
// `$...$` so renderers see balanced math delimiters.
//
// Only runs on the whole string (after trim) — we never grab
// arbitrary substrings out of long prose.
function rewriteBookendCurrencyEquation(text: string): string {
  const trimmed = text.trim();
  let inner: string | null = null;
  if (trimmed.startsWith("\\$") && trimmed.endsWith("\\$") && trimmed.length >= 8) {
    inner = trimmed.slice(2, -2);
  } else if (
    trimmed.startsWith("$") &&
    !trimmed.startsWith("\\$") &&
    trimmed.endsWith("$") &&
    !trimmed.endsWith("\\$") &&
    trimmed.length >= 6
  ) {
    inner = trimmed.slice(1, -1);
  }
  if (inner == null) return text;
  if (!inner.includes("=")) return text;
  if (!/[+\-*/()a-zA-Z]/.test(inner)) return text;
  // Inner already has math delimiters → AI partially wrapped; leave
  // it alone rather than risk double-wrapping.
  if (inner.includes("$")) return text;
  return `$${inner}$`;
}

export function normalizeMath(text: string): string {
  if (!text) return text;
  text = rewriteBookendCurrencyEquation(text);
  text = collapseOrphanThinSpace(text);
  text = unwrapMathCurrency(text);
  // Protect existing math/code/url spans BEFORE the currency escape
  // step. Otherwise a legitimate `$950 + … = …$` math wrap looks like
  // currency to escapeBareCurrency, which then breaks the wrap. The
  // escape only needs to run on the UNPROTECTED prose between math
  // chunks.
  const { parts, protectedSpans } = splitProtected(text);
  const transformed = parts
    .map((part) => {
      if (part.startsWith(PLACEHOLDER_PREFIX)) return part;
      let p = part;
      p = escapeBareCurrency(p);
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
