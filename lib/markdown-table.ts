// Pure helper (no server deps) so client components can share it.
// A GFM table needs a header row of pipes AND a dash separator row
// (| --- | --- |). A single line with pipes is not enough.
export function hasMarkdownTable(text: string | null | undefined): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    const sep = lines[i + 1].trim();
    if (/^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(sep)) return true;
  }
  return false;
}
