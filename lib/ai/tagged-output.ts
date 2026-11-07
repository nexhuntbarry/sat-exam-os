// lib/ai/tagged-output.ts
//
// Verbatim text from the model in XML-style tags instead of JSON strings.
//
// Why: generateObject makes the model write passage text inside a JSON string.
// SAT passages are full of quoted titles and words (“The Selfish Giant.”,
// “broader”), and at an opening quote the model regularly types a bare
// straight " — which ENDS the JSON string. The rest of the stem is silently
// lost, and a choice that starts with a quote comes back "" (Test #14 English
// M1/M2, 13 questions; reproduced 2/2 on M2 Q1/Q2 with QUOTE_RULE in the
// prompt). Text inside tags needs no escaping, so a quote can't end it.

/** Prompt lines for any call that returns text through these tags. */
export const TAGGED_TEXT_RULES = `OUTPUT FORMAT — plain text inside tags, NOT JSON:
- Write every field exactly inside its tags, as shown. Nothing outside the tags.
- Copy quotation marks exactly as printed (“ ” " ' ‘ ’) — inside tags they need no escaping and never end the text.
- No JSON escaping: write LaTeX with single backslashes ($\\frac{1}{2}$, \\$5), real line breaks for paragraph breaks.`;

/** Undo JSON-style escaping a model may still type out of habit (\\frac → \frac). */
export function unescapeTagText(s: string): string {
  return s
    .replace(/\\\\(?=[A-Za-z$%&#_{}])/g, "\\")
    .replace(/\\n(?![A-Za-z])/g, "\n");
}

/** Text of the first <tag>…</tag>. An unclosed last tag (output cut by the token limit) returns what's there. */
export function readTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (m) return m[1];
  const open = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*)$`));
  return open ? open[1] : null;
}

/** Every <tag attr="…">…</tag>, with its attributes. */
export function readTags(text: string, tag: string): { attrs: Record<string, string>; body: string }[] {
  const out: { attrs: Record<string, string>; body: string }[] = [];
  const re = new RegExp(`<${tag}((?:\\s+[a-zA-Z_]+="[^"]*")*)\\s*>([\\s\\S]*?)</${tag}>`, "g");
  for (const m of text.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ attrs, body: m[2] });
  }
  return out;
}

/** Field text: trimmed, JSON-habit escapes undone. */
export function cleanTagText(s: string | null | undefined): string {
  return unescapeTagText(s ?? "").trim();
}
