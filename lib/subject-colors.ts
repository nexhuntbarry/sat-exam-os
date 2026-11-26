// One palette for "which subject is this": SubjectTag chips, the score chart
// lines, and the printouts / one-page parent PDF (rendered from the same
// React pages by headless Chromium, so they pick this up through SubjectTag
// and ScoreProgressChart).
//
// Contrast (WCAG, text on its background):
//   Math  #1E4E8C on #E6EEF9  7.12:1
//   R&W   #7A5A12 on #F8EED9  5.52:1
//   Full  #FFFFFF on #0C2A55 14.21:1 (the Premier navy of the parent report band)
// Math and R&W backgrounds are almost the same lightness (relative luminance
// 0.848 vs 0.861), so in black-and-white print Math is told apart by its
// dark outline (`border`), R&W has none, and Full-length is a dark chip.

export type SubjectKind = "math" | "rw" | "full";

export const SUBJECT_COLORS = {
  math: { bg: "#E6EEF9", text: "#1E4E8C", border: "#1E4E8C" },
  rw: { bg: "#F8EED9", text: "#7A5A12", border: "#F8EED9" },
  full: { bg: "#0C2A55", text: "#FFFFFF", border: "#0C2A55" },
} as const;

/** Score chart line colours: the tag text colours, readable as lines and labels on white. */
export const SUBJECT_LINE_COLORS = {
  math: SUBJECT_COLORS.math.text, // 8.32:1 on white
  rw: SUBJECT_COLORS.rw.text, // 6.37:1 on white
} as const;

/** Map a section / subject string (DB value, short form, or kind) to a SubjectKind. */
export function subjectKind(section: string | null | undefined, fullLength?: boolean): SubjectKind | null {
  if (fullLength) return "full";
  const s = (section ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "math") return "math";
  if (s === "rw" || s === "r&w" || s === "reading & writing" || s === "reading and writing") return "rw";
  if (s === "full" || s === "fl" || /full[\s-]?length/.test(s)) return "full";
  return null;
}
