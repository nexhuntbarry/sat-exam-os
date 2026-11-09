// lib/review-evidence.ts
//
// Plain-language Review Queue cards (Premier 2026-11-07 item 6, retest
// 2026-11-08): one decision line ("Key says B, solving gives C"), short
// evidence in plain English ("PDF ✓: A · Code: A · Second solve: A ·
// Saved: D") and the answer the "Use X" button would set. The technical
// notes ("plug-back of 17 fails … [verify-ai-key 2026-11-07]") stay behind
// the card's "Details" toggle. Pure (no DB / AI).

import { SPR_TYPE } from "@/lib/answer-key";
import { parseKeyDoubt, KEY_DOUBT_PREFIX } from "@/lib/key-doubt";
import { LIVE_FIX_TAG } from "@/lib/live-questions";
import { noteSegments, parseKeyDispute, type ReviewGroupId } from "@/lib/review-queue";
import { checksFromSummary, contentHash, noteStemHash, parseAiKeyDisagreeNote, sameKey, solvesAgree, sprKeyFromSolves, type VerifyChecks } from "@/lib/verify-ai-key";
import type { AutoFixRow } from "@/lib/explanation-autofix";

export interface EvidenceItem {
  label: string;
  value: string;
  /** Agrees with the saved key / differs from it / neutral. */
  tone: "agree" | "differ" | "neutral";
}

export interface KeySuggestion {
  answer: string;
  /** Plain words: where the answer comes from. */
  why: string;
  /** Two independent checks agree, or the PDF's answer key says so. */
  strong: boolean;
}

export interface KeyCard {
  headline: string;
  evidence: EvidenceItem[];
  suggestion: KeySuggestion | null;
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** Drop machine tags: "[verify-ai-key 2026-11-07]", "[compare:https://…]". */
const untag = (s: string) => s.replace(/\s*\[(?:verify-ai-key|spot-check|compare:)[^\]]*\]/g, "").trim();

/**
 * The verify-ai-key checks recorded on the row (latest note first). `stale`:
 * the note's fingerprint shows they were made on another version of the
 * question text / choices.
 */
export function rowChecks(r: Pick<AutoFixRow, "parsing_notes" | "question_text" | "choices">): { checks: VerifyChecks; stale: boolean; current: boolean } | null {
  const segs = noteSegments(r.parsing_notes);
  for (let i = segs.length - 1; i >= 0; i--) {
    const d = parseAiKeyDisagreeNote(segs[i]);
    const v = segs[i].match(/^AI-only key verified \((.*)\) \[verify-ai-key [^\]]*\]$/);
    const c = d?.detail ? checksFromSummary(d.detail) : v ? checksFromSummary(v[1]) : null;
    if (c) {
      const h = noteStemHash(segs[i]);
      // current: made on exactly this text (a fingerprint that matches). An
      // older note without a fingerprint is neither stale nor current.
      return { checks: c, stale: h !== null && h !== contentHash(r), current: h !== null && h === contentHash(r) };
    }
  }
  return null;
}

/** The key decision on one card. `pdfKey`: the official answer only when it really comes from the PDF. */
export function keyCard(r: Pick<AutoFixRow, "correct_answer" | "question_type" | "question_text" | "parsing_notes" | "choices">, pdfKey: string | null): KeyCard {
  const saved = (r.correct_answer ?? "").trim() || "∅";
  const isMc = r.question_type !== SPR_TYPE;
  const same = (a: string | null | undefined) => !!a && sameKey(a, saved, isMc, r.question_text ?? null);
  const tone = (a: string | null | undefined): EvidenceItem["tone"] => (!a ? "neutral" : same(a) ? "agree" : "differ");
  const evidence: EvidenceItem[] = [];
  evidence.push({ label: "PDF ✓", value: pdfKey ?? "no key in the PDF", tone: pdfKey ? tone(pdfKey) : "neutral" });

  const rc = rowChecks(r);
  const ch = rc?.checks ?? null;
  const stale = !!rc?.stale;
  const current = !!rc?.current;
  const segs = noteSegments(r.parsing_notes);
  let agreeing: string | null = null;
  let solvesSplit: [string, string] | null = null;
  if (ch) {
    const a = ch.first?.answer ?? null;
    const b = ch.second?.answer ?? null;
    const math = ch.section === "Math";
    const old = stale ? " (older text)" : "";
    evidence.push({ label: `${math ? "Code" : "Solve 1"}${old}`, value: a ?? "no answer", tone: tone(a) });
    evidence.push({ label: `${math ? "Second solve" : "Solve 2"}${old}`, value: b ?? "no answer", tone: tone(b) });
    if (ch.plugBack && ch.plugBack.status !== "n/a") {
      evidence.push({ label: `Putting ${saved} back in`, value: ch.plugBack.status === "pass" ? "works" : "doesn't work", tone: ch.plugBack.status === "pass" ? "agree" : "differ" });
    }
    if (a && b && ch.first && ch.second) {
      if (solvesAgree(ch.first, ch.second, isMc, r.question_text ?? null)) agreeing = !same(a) ? (isMc ? a : sprKeyFromSolves(a, b, r.question_text ?? null) ?? a) : null;
      else solvesSplit = [a, b];
    }
  }
  // Other AI evidence (when there's no verify-ai-key note).
  const regen = segs.map((s) => s.match(/^Needs review: AI's own answer is (.+?) but the saved key is/)).find(Boolean);
  if (regen && !ch) evidence.push({ label: "Solving without the key", value: regen[1], tone: tone(regen[1]) });
  const doubt = parseKeyDoubt(segs.find((s) => s.startsWith(KEY_DOUBT_PREFIX)) ?? null);
  if (doubt && !ch) evidence.push({ label: "AI review", value: doubt.suggested, tone: tone(doubt.suggested) });
  const dispute = parseKeyDispute(r.parsing_notes, r.correct_answer, pdfKey);
  if (!ch && !regen && !doubt && dispute?.alternative && dispute.source !== "official key") {
    evidence.push({ label: dispute.source === "AI" ? "AI solve" : dispute.source.replace(/^./, (c) => c.toUpperCase()), value: dispute.alternative, tone: tone(dispute.alternative) });
  }
  evidence.push({ label: "Saved key", value: saved, tone: "neutral" });

  let suggestion: KeySuggestion | null = null;
  let headline: string;
  if (pdfKey && !same(pdfKey)) {
    suggestion = { answer: pdfKey, why: "the PDF's answer key", strong: true };
    headline = `Key says ${saved}, the PDF's answer key says ${pdfKey}`;
  } else if (agreeing) {
    // Solves of an older text are a hint, not a strong suggestion.
    // Strong (and in "Accept all") only for solves made on this exact text.
    suggestion = {
      answer: agreeing,
      why: stale ? "both solves (made on an older version of the text)" : current ? "both independent solves" : "both solves (not confirmed for the current text)",
      strong: current,
    };
    headline = `Key says ${saved}, solving gives ${agreeing}${stale ? " (on an older version of the text)" : ""}`;
  } else if (solvesSplit) {
    const alt = solvesSplit.find((x) => !same(x)) ?? null;
    suggestion = alt ? { answer: alt, why: "one of the two solves", strong: false } : null;
    headline = `Key says ${saved}; the two solves disagree (${solvesSplit[0]} vs ${solvesSplit[1]})`;
  } else {
    const d = dispute;
    if (d?.alternative) {
      suggestion = { answer: d.alternative, why: d.source === "official key" ? "the answer key" : `the ${d.source}`, strong: false };
      headline = `Key says ${saved}, ${d.source === "official key" ? "the answer key" : d.source} gives ${d.alternative}`;
    } else headline = `Is ${saved} the right key?`;
  }
  return { headline, evidence, suggestion };
}

/** One reason in plain English (the raw note stays under "Details"). */
export function plainReason(text: string): string {
  const t = untag(text.replace(/^note: /, "").trim());
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^Needs review: key says (.+?), AI says (.+?)(?: \([^)]*\))?(?: — .*)?$/, (m) => `Key says ${m[1]}; checking it gives ${m[2]}.`],
    [/^Needs review: AI's own answer is (.+?) but the saved key is (.+?) —/, (m) => `Solving it without the key gives ${m[1]}, not the saved ${m[2]}.`],
    [/^Needs review: AI thinks the answer key may be wrong \(stored (.+?), AI suggests (.+?)\)/, (m) => `An AI review thinks the key ${m[1]} may be wrong (suggests ${m[2]}).`],
    [/^Mismatch: AI answered (.+?), official (.+)$/i, (m) => `The AI answered ${m[1]}; the answer key says ${m[2]}.`],
    [/^key (.+?) differs from the official answer (.+)$/, (m) => `The saved key ${m[1]} differs from the PDF's answer key ${m[2]}.`],
    [/^Solver self-contradicted \(declared (.+?), explained (.+?)\)$/, (m) => `The AI solver contradicted itself (said ${m[1]}, explained ${m[2]}); the key isn't checked.`],
    [/^stored the explained answer "(.*)"/, (m) => `The key ${m[1]} came from an AI solve that contradicted itself.`],
    [/^Answer & explanation generated by AI solver/, () => "The key came from one AI solve and hasn't been checked."],
    [/^Consensus solve NOT unanimous \(([^)]*)\)/, (m) => `AI solves disagreed (${m[1]}).`],
    [/^Needs review: figure check — the stored (.+?) differs? from the source PDF/, (m) => `The stored ${m[1]} look${/s$/.test(m[1]) ? "" : "s"} different from the PDF.`],
    [/still needs review \(figure\/choices\)/i, () => "Check the figure and answer choices against the PDF."],
    [/^Image re-extracted by admin self-repair/i, () => "The figure was re-cut from the PDF automatically; check it matches."],
    [/^the question's figure is missing$/, () => "The question mentions a figure, but none is attached."],
    [/question text looks cut off/i, () => "The question text looks cut off."],
    [/two (?:completely )?unrelated problems|concatenat/i, () => "The question text has two different questions merged together."],
    [/re-extracted from the PDF[^;]*check the explanation/i, () => "The text was re-read from the PDF; check the explanation still fits."],
    [/generated explanation looks cut off|^explanation: still cut off|explanation looks cut off/i, () => "The explanation is cut off."],
    [/^Needs review: no checked explanation for the new key (\S+)/, (m) => `No checked explanation yet for the key ${m[1]}.`],
    [/^Needs review: computed-answer check disagrees — stated answer (\S+)/, (m) => `The explanation's math doesn't reach its stated answer ${m[1]}.`],
    [/^Needs review: the uploaded answer key says (\S+) but the source PDF/, (m) => `The uploaded answer key says ${m[1]}, but the PDF's ✓ mark disagrees.`],
    [/answer key disagrees with the solved answer on (\d+) of (\d+)/, (m) => `This module's answer key disagrees with the solved answers on ${m[1]} of ${m[2]} questions; it may belong to another module.`],
    [/SPR question has a letter answer|correct_answer is listed as '[A-D]' but this is a Student Produced Response/i, () => "A fill-in question has a letter as its key."],
    [/^check: math-render-failed$/, () => "Some math doesn't render."],
    [/^check: math-contains-prose$/, () => "Words are stuck inside a math formula."],
    [/^check: (.+)$/, (m) => `Automatic check failed: ${m[1].replace(/-/g, " ")}.`],
    [/^approve check: (.+)$/, (m) => `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}.`],
    [/^explanation: (.+)$/, (m) => `Explanation: ${m[1]}.`],
    [/stray backslash/i, () => "A stray backslash shows in the text."],
    [/^Re-extracted by admin self-repair \(\w+\)/i, () => "The text was re-read from the PDF automatically and the key hasn't been verified on the new text: compare it with the PDF."],
    [/^every check passes$/, () => "Every automatic check passes."],
  ];
  if (t.startsWith(LIVE_FIX_TAG)) {
    return short(t.replace(/^\[live-fix\]\s*/, "").replace(/;?\s*kept (?:Approved|Needs Review)\s*—\s*please re-check\.?.*$/i, "").trim() || "Changed while in a live test.");
  }
  const sem = t.match(/^Semantic audit:\s*(.*)$/i);
  if (sem) return short(`AI review: ${sem[1].split(/,\s(?=[A-Z])/)[0].replace(/\.$/, "")}.`, 160);
  for (const [re, f] of rules) {
    const m = t.match(re);
    if (m) return f(m);
  }
  return short(t.replace(/^Needs review:\s*/i, "").replace(/^./, (c) => c.toUpperCase()), 160);
}

/** The one-line decision for a non-key card: its first reason in that group, in plain words. */
export function groupHeadline(group: ReviewGroupId, reasons: { group: ReviewGroupId; text: string }[]): string {
  const first = reasons.find((x) => x.group === group) ?? reasons[0];
  return first ? plainReason(first.text) : "Check it and approve.";
}
