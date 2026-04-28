/**
 * Map raw parser/AI error messages stored in `modules.parsing_error` to a
 * short, user-friendly message that an admin can act on without reading
 * the underlying stack trace.
 *
 * The raw message is preserved verbatim in the column; this helper only
 * affects how the UI renders it.
 */

export interface FriendlyParseError {
  /** One-sentence cause an admin understands. */
  summary: string;
  /** What the admin can do next. */
  hint: string;
}

const PATTERNS: Array<{ test: RegExp; out: FriendlyParseError }> = [
  {
    test: /fetch failed|ENOTFOUND|ECONNREFUSED|network|TLS/i,
    out: {
      summary: "The PDF couldn't be downloaded from storage.",
      hint: "Re-upload the PDF and try parsing again. If it keeps failing, check that Vercel Blob isn't rate-limited.",
    },
  },
  {
    test: /\b429\b|rate.?limit|too many requests/i,
    out: {
      summary: "The AI service is rate-limited.",
      hint: "Wait 1–2 minutes and click Retry. If it persists, lower the parsing concurrency.",
    },
  },
  {
    test: /context|token.*(limit|exceed|too long)|max.*tokens/i,
    out: {
      summary: "The PDF is too long for the AI to handle in one pass.",
      hint: "Split the PDF into smaller files (e.g. one section per file) and upload separately.",
    },
  },
  {
    test: /0 questions|empty or unreadable|no questions detected/i,
    out: {
      summary: "No questions were detected in the PDF.",
      hint: "Confirm this is a real SAT module and the text is selectable (not a scanned image). If scanned, run OCR first or use a different source.",
    },
  },
  {
    test: /not.?sat|rejected|wrong.?format/i,
    out: {
      summary: "The PDF doesn't look like an SAT module.",
      hint: "Double-check that the file matches the section/module number you set, then re-upload the correct PDF.",
    },
  },
  {
    test: /JSON|schema|parse.*output|invalid.*response/i,
    out: {
      summary: "The AI response was malformed.",
      hint: "Click Retry — this is usually transient. If it fails 3+ times, ping the dev team with the module ID.",
    },
  },
  {
    test: /timeout|deadline|aborted|FUNCTION_INVOCATION_TIMEOUT/i,
    out: {
      summary: "Parsing took too long and was cancelled.",
      hint: "The PDF is likely too dense. Split it into smaller files and retry.",
    },
  },
  {
    test: /unauthorized|forbidden|401|403/i,
    out: {
      summary: "The AI provider rejected the request (auth issue).",
      hint: "Ask the dev team to check ANTHROPIC_API_KEY in Vercel — the key may be revoked or out of credit.",
    },
  },
  {
    test: /image|crop|extract.*image/i,
    out: {
      summary: "Image extraction failed (non-fatal).",
      hint: "Questions still parsed; affected items will show without inline figures. Click Retry only if you need the images.",
    },
  },
];

const FALLBACK: FriendlyParseError = {
  summary: "Parsing failed for an unknown reason.",
  hint: "Click Retry once. If it still fails, copy the raw error below and send it to the dev team.",
};

export function friendlyParseError(raw: string | null | undefined): FriendlyParseError {
  if (!raw) return FALLBACK;
  for (const { test, out } of PATTERNS) {
    if (test.test(raw)) return out;
  }
  return FALLBACK;
}
