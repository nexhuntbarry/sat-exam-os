// lib/friendly-parsing-notes.ts
//
// The questions.parsing_notes column holds raw technical strings
// (`Demoted by post-parse-cleanup: failed checks → math-render-failed`,
// `Possible duplicate of question 69571cb2-9788-… (similarity 1.00); Pending AI answer`)
// that scare admin reviewers when surfaced verbatim. This module
// translates those raw notes into plain-language status banners
// the reviewer can actually act on.
//
// Public API:
//   friendlyParsingNote(raw) →
//     { tone, headline, detail?, action? }
//
//   tone     — "info" | "warning" | "error"
//   headline — short plain-English sentence shown big
//   detail   — optional secondary line; never includes raw UUIDs,
//              regex IDs, or backtrace-style fragments
//   action   — optional "what to do next" hint

export interface NoteAction {
  /** Button label shown to the admin. */
  label: string;
  /** Path relative to the question id, e.g. "/repair-math". The
   *  client makes a POST to /api/admin/questions/{id}{path}. */
  path: string;
  /** Optional confirm prompt before firing. */
  confirm?: string;
  /** Optional "running" text shown while the request is in flight
   *  (defaults to label + "…"). */
  pending?: string;
}

export interface FriendlyNote {
  tone: "info" | "warning" | "error";
  headline: string;
  detail?: string;
  action?: string;
  actions?: NoteAction[];
}

interface CheckMeta {
  headline: string;
  action: string;
  actions?: NoteAction[];
}

const MATH_REPAIR_ACTION: NoteAction = {
  label: "Auto-fix with AI",
  path: "/repair-math",
  confirm:
    "Send this question back to Claude with stricter formatting rules? This costs ~$0.01 per attempt and moves the row to Draft so you can re-review.",
  pending: "Repairing…",
};

const IMAGE_REPAIR_ACTION: NoteAction = {
  label: "Re-extract figure from PDF",
  path: "/repair-image",
  confirm:
    "Re-run the image cropper for this question? Claude will pick a fresh bounding box and upload the new crop.",
  pending: "Re-cropping…",
};

const CLEAR_TABLE_ACTION: NoteAction = {
  label: "Mark as 'no table needed'",
  path: "/clear-table-flag",
  confirm: "Confirm this question doesn't actually need a data table?",
  pending: "Clearing flag…",
};

const CLEAR_IMAGE_ACTION: NoteAction = {
  label: "Mark as 'no figure needed'",
  path: "/clear-image-flag",
  confirm:
    "Confirm this question doesn't actually need a figure / diagram?",
  pending: "Clearing flag…",
};

const CHECK_LABELS: Record<string, CheckMeta> = {
  "math-render-failed": {
    headline: "Math formatting won't render",
    action:
      "Tap Auto-fix below to have Claude re-extract this question, or open Edit raw and fix the field by hand.",
    actions: [MATH_REPAIR_ACTION],
  },
  "math-render-fail": {
    headline: "Math formatting won't render",
    action:
      "Tap Auto-fix below to have Claude re-extract this question, or open Edit raw and fix the field by hand.",
    actions: [MATH_REPAIR_ACTION],
  },
  "math-unwrapped": {
    headline: "Raw math leaked outside $...$",
    action:
      "Tap Auto-fix to re-extract, or wrap the bare expression in $...$ manually.",
    actions: [MATH_REPAIR_ACTION],
  },
  "math-contains-prose": {
    headline: "English text got swallowed inside a $...$ math wrap",
    action:
      "Tap Auto-fix to have Claude re-extract this question — the math wrap is too long and pulled in regular words like 'what is the value of'.",
    actions: [MATH_REPAIR_ACTION],
  },
  "blind-image": {
    headline: "This question needs a figure that wasn't extracted",
    action:
      "Tap Re-extract figure to let Claude pick a fresh bounding box and crop it. If you've checked the PDF and there genuinely is no figure, use 'Mark as no figure needed' instead.",
    actions: [IMAGE_REPAIR_ACTION, CLEAR_IMAGE_ACTION],
  },
  "has-table-flag-but-no-table-in-text": {
    headline: "Data table is missing from the question text",
    action:
      "Tap Auto-fix to re-extract the table. If you've verified the question doesn't need one, use 'Mark as no table needed' instead.",
    actions: [MATH_REPAIR_ACTION, CLEAR_TABLE_ACTION],
  },
  "pipe-flattened-table": {
    headline: "Table got flattened into one line",
    action:
      "Split the pipe-separated content back into separate rows with a header / dash separator.",
  },
  "mcq-answer-not-in-choices": {
    headline: "Correct answer doesn't match any choice letter",
    action:
      "Pick the right answer from the four choices or fix the correct_answer field.",
  },
  "mcq-bad-choice-count": {
    headline: "Multiple Choice question doesn't have exactly 4 options",
    action:
      "Add the missing A/B/C/D entry or remove the extra one.",
  },
  "spr-with-letter-answer": {
    headline: "Grid-in question has a letter answer",
    action:
      "Switch the type to Multiple Choice or replace the letter with the numeric value.",
  },
  "empty-text": {
    headline: "Question stem is empty",
    action: "Re-extract this question from the source PDF.",
  },
  "empty-answer": {
    headline: "Answer key is empty",
    action: "Add the correct answer letter or value.",
  },
  "rw-misclassified-as-spr": {
    headline: "Reading & Writing question marked as a grid-in by mistake",
    action: "Switch type to Multiple Choice and add the four options.",
  },
  "blank-artifact": {
    headline: "Parser left the word 'blank' next to underscores",
    action: "Delete the literal word 'blank' — the underscores ARE the blank.",
  },
  "image-url-malformed": {
    headline: "An image URL on this question won't load",
    action: "Tap Re-extract figure to upload a fresh crop.",
    actions: [IMAGE_REPAIR_ACTION, CLEAR_IMAGE_ACTION],
  },
  "explanation-final-mismatch": {
    headline: "Explanation's stated answer doesn't match the correct_answer",
    action:
      "Check the PDF answer key and either fix the correct_answer field or rewrite the last line of the explanation.",
  },
};

function labelForCheck(check: string): CheckMeta {
  return (
    CHECK_LABELS[check] ?? {
      headline: `Audit check failed (${check})`,
      action:
        "Open the source PDF and re-verify this row, then save to clear the flag.",
    }
  );
}

const RAW = (s: string) => s.replace(/\s+/g, " ").trim();

export function friendlyParsingNote(raw: string | null): FriendlyNote | null {
  if (!raw) return null;
  const text = RAW(raw);

  // ── Demoted by post-parse-cleanup / audit-auto-approved ───────────
  const demote = text.match(
    /Demoted by [\w./-]+(?: \d{4}-\d{2}-\d{2})?:\s*failed checks?\s*[→\->]+\s*(.+)$/i,
  );
  if (demote) {
    const ids = demote[1]
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 1) {
      const meta = labelForCheck(ids[0]);
      return {
        tone: "warning",
        headline: meta.headline,
        action: meta.action,
        actions: meta.actions,
      };
    }
    // Multiple checks failed — deduplicate actions across all ids.
    const headlines = ids.map((id) => labelForCheck(id).headline);
    const seen = new Set<string>();
    const actions: NoteAction[] = [];
    for (const id of ids) {
      for (const a of labelForCheck(id).actions ?? []) {
        if (!seen.has(a.path)) {
          seen.add(a.path);
          actions.push(a);
        }
      }
    }
    return {
      tone: "warning",
      headline: `${ids.length} issues found on this question`,
      detail: headlines.join(" · "),
      action: ids.map((id) => labelForCheck(id).action).join(" "),
      actions: actions.length > 0 ? actions : undefined,
    };
  }

  // ── Possible duplicate ────────────────────────────────────────────
  if (/possible duplicate of question/i.test(text)) {
    const pending = /pending ai answer/i.test(text);
    return {
      tone: "warning",
      headline: "Looks like a duplicate of another question",
      detail: pending
        ? "The AI is still picking an answer for this row."
        : undefined,
      action: "Compare to the other row and either merge or delete this one.",
    };
  }

  // ── Pending AI answer (standalone) ────────────────────────────────
  if (/^pending ai answer/i.test(text)) {
    return {
      tone: "info",
      headline: "Waiting for the AI to fill in the answer",
      detail: "This usually finishes within a minute or two of the parse.",
    };
  }

  // ── Needs manual image re-extraction (from resolveBlindImages) ────
  if (/needs manual image re-extraction/i.test(text)) {
    return {
      tone: "warning",
      headline: "This question needs a figure that wasn't extracted",
      action: "Tap Re-extract figure to let Claude pick a fresh bounding box and crop it.",
      actions: [IMAGE_REPAIR_ACTION],
    };
  }

  // ── Re-extracted / re-promoted notes (positive) ───────────────────
  if (/re-extracted by repair-blind-image-regions/i.test(text)) {
    return {
      tone: "info",
      headline: "Figure was re-cropped — please verify it looks right",
    };
  }
  if (/re-promoted by post-parse-cleanup/i.test(text)) {
    return {
      tone: "info",
      headline: "Earlier issue cleared automatically — re-review before approving",
    };
  }
  if (/re-extracted by repair-math-render-failed/i.test(text)) {
    return {
      tone: "info",
      headline: "Math was re-extracted — please verify it renders right",
    };
  }
  if (/cleared has_image flag/i.test(text)) {
    return {
      tone: "info",
      headline: "Image flag was cleared automatically (no figure needed)",
    };
  }

  // ── Choices recovered ─────────────────────────────────────────────
  if (/choices re-extracted by post-parse-cleanup/i.test(text)) {
    return {
      tone: "warning",
      headline: "Answer choices were re-extracted",
      action: "Verify the correct_answer letter still maps to the right choice.",
    };
  }

  // ── Mismatch: AI vs official answer key ───────────────────────────
  const mismatch = text.match(
    /Mismatch:\s*AI answered\s+([^,;]+?)\s*,\s*official answer is\s+([^,;]+)/i,
  );
  if (mismatch) {
    return {
      tone: "warning",
      headline: "AI disagrees with the official answer key",
      detail: `AI picked ${mismatch[1]}; official key says ${mismatch[2]}.`,
      action: "Use the mismatch resolver below to pick which one to trust.",
    };
  }

  // ── Explanation references X but correct_answer is Y ──────────────
  const explConflict = text.match(
    /Explanation references\s+([A-D/]+)\s+but correct_answer is\s+([A-D])/i,
  );
  if (explConflict) {
    return {
      tone: "warning",
      headline: "Explanation contradicts the stored answer",
      detail: `Explanation mentions ${explConflict[1]}; correct_answer is ${explConflict[2]}.`,
      action:
        "Check the PDF answer key and either fix the answer field or rewrite the explanation's last line.",
    };
  }

  // ── Fallback: keep the original message but mark it as a flag ────
  return {
    tone: "warning",
    headline: "Reviewer flag",
    detail: text,
  };
}
