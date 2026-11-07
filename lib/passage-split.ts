// Heuristic: for R&W questions whose stems carry a long passage, find
// the LAST sentence that looks like the actual question and split
// `question_text` into { passage, stem }. Everything before the
// question sentence is treated as the passage; everything from that
// sentence onward (including its terminator) is the stem.
//
// Triggers shown to start a question stem in SAT R&W:
//   "Which choice…", "Which of the following…", "What is…",
//   "Which finding…", "The author's main purpose…", "Based on the
//   passage…", "As used in…", etc.
//
// Returns { passage: null, stem: text } when no split is warranted —
// then the renderer falls back to single-column mode.
export function splitPassageAndStem(raw: string): { passage: string | null; stem: string } {
  if (!raw) return { passage: null, stem: raw };
  // Triggers are matched case-insensitive at sentence boundaries.
  const triggers = [
    "which choice",
    "which of the following",
    "which finding",
    "what is the main",
    "what is the purpose",
    "what does the",
    "what choice",
    "based on the passage",
    "based on the text",
    "as used in",
    "the author",
    "the text most strongly",
    "the passage most strongly",
    "according to the passage",
    "according to the text",
    "in the context",
  ];
  const lower = raw.toLowerCase();
  let bestStart = -1;
  for (const t of triggers) {
    let idx = lower.indexOf(t);
    while (idx !== -1) {
      // A sentence ends in . ! ? possibly followed by closing quotes,
      // brackets, markdown emphasis or inline HTML close tags — e.g. a
      // passage ending in an underlined run "…potatoes.</u>" or a quote
      // "…deceived.\"" still ends a sentence.
      const before = raw.slice(0, idx).trimEnd();
      const isSentenceStart = idx === 0 || /[.!?](?:["'”’)\]*_]|<\/[a-z]+>)*$/i.test(before);
      if (isSentenceStart) {
        if (idx > bestStart) bestStart = idx;
      }
      idx = lower.indexOf(t, idx + 1);
    }
  }
  // Only split when there's meaningful passage content before the trigger.
  // 200 chars is roughly two long sentences — below that the question is
  // already concise and single-column reads better.
  if (bestStart < 200) return { passage: null, stem: raw };
  // Walk back to the previous sentence terminator so the passage ends
  // cleanly instead of mid-sentence.
  let cut = bestStart;
  for (let i = bestStart - 1; i >= 0; i--) {
    const c = raw[i];
    if (c === "." || c === "!" || c === "?" || c === "\n") {
      cut = i + 1;
      break;
    }
  }
  // Rhetorical-synthesis ("While researching a topic, a student has taken
  // the following notes: …") puts the goal sentence and the question in one
  // paragraph (or the paragraph just above it) — "The student wants to …
  // Which choice …". Both belong to the question pane, so pull the goal
  // sentence into the stem.
  const paraStart = raw.slice(0, cut).trimEnd().lastIndexOf("\n") + 1;
  // Only for the notes format: the text above must say the student took
  // notes, so a passage paragraph that happens to begin "The student
  // wants…" is never pulled out of the passage.
  const notesAbove = /\bstudent has taken the following notes\b|^\s*[-•*]\s/im.test(raw.slice(0, paraStart));
  if (paraStart > 0 && notesAbove && /^the student wants\b/i.test(raw.slice(paraStart))) {
    cut = paraStart;
  }
  const passage = raw.slice(0, cut).trim();
  const stem = raw.slice(cut).trim();
  if (!stem) return { passage: null, stem: raw };
  return { passage, stem };
}
