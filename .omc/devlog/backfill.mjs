#!/usr/bin/env node
// .omc/devlog/backfill.mjs — one-off: today's (2026-10-29) changes for /admin/reports.
// EDIT the placeholder text (marked TODO-EDIT) before running, then:
//   node .omc/devlog/backfill.mjs          # writes the entries (needs .omc/devlog/enabled)
//   node .omc/devlog/backfill.mjs --dry    # prints what it would write
import { sourceKind, writeEntry } from "./lib.mjs";

const DRY = process.argv.includes("--dry");
const DATE = "2026-10-29";
const NIGHTLY = ["SMOKE", "HP-MATH", "HP-ADAPTIVE-HARD", "HP-UNTIMED", "ISO-01", "GRADE-SAMPLE", "BANK-IMG", "PROD-HEALTH", "SAFARI", "REAL-SCORES"];

const change = (e) => ({
  kind: "change", date: DATE, body: "", ticket_id: null, commit: null, roles: [], verified: [],
  ...e, source_kind: sourceKind(e.source, e.ticket_id),
});

const entries = [
  change({
    type: "bug", commit: "2467d9a", source: "Report a Problem", ticket_id: "7deac2cc-f106-4866-8d9c-07e481283448",
    roles: ["admin"],
    title: "Review page: Next goes on to the next module",
    body: "TODO-EDIT: On the question review page, Next / Approve & Next now continue to the next module that still has questions to review, instead of stopping at the end of the current one.",
  }),
  change({
    type: "bug", commit: "6af4c49", source: "Report a Problem", ticket_id: "33feaba1-a0e0-49b3-a937-60a16e72148b",
    roles: ["student", "teacher", "admin"], verified: NIGHTLY,
    title: "Question figures: tighter crops, graph answer choices, no answer hints in image text",
    body: "TODO-EDIT: Figures are cropped to just the graph or table, questions whose answer choices are graphs show the graphs as choices, and the hidden image descriptions no longer give away the answer.",
  }),
  {
    kind: "bank_change", date: DATE, ticket_id: "33feaba1-a0e0-49b3-a937-60a16e72148b", rescored: 0, // TODO-EDIT if any rescoring ran
    title: "Question images re-cropped and graph-choice questions fixed",
    body: "43 question images replaced, 10 removed, 4 questions now use graphs as answer choices, and 2 fill-in (student-produced response) questions had stray answer choices cleared.",
  },
  change({
    type: "feature", commit: "6af4c49", source: "Report a Problem", ticket_id: "d73e7fa4-8e2f-407b-bb9c-e5469ec29b3d",
    roles: ["teacher", "admin"],
    title: "Test progress counts per student",
    body: "TODO-EDIT: The test page shows how many students have not started, are in progress, and have finished.",
  }),
  change({
    type: "feature", commit: "9ad167d", source: "Report a Problem (Barry approved)", ticket_id: "b34191b0-3c68-41d1-8b2f-7b9238777bf4",
    roles: ["admin"],
    title: "Crop or delete question images on the review page",
    body: "TODO-EDIT: Reviewers can crop an extracted question image or delete it right on the review page.",
  }),
  change({
    type: "bug", commit: "6cb96f2", source: "Barry's request", roles: ["student", "teacher"],
    title: "Moving a due date mid-exam no longer marks an on-time exam Late",
    body: "TODO-EDIT: If a teacher changes the due date while a student is taking the test, a student who started on time is not marked Late.",
  }),
  change({
    type: "bug", commit: "c1d633e", source: "QA finding D-20261029-3", roles: ["student"],
    title: "Answers typed with a Chinese/Japanese keyboard are graded correctly",
    body: "TODO-EDIT: Full-width digits (e.g. １２) typed with a CJK input method are now read as normal numbers when grading fill-in answers.",
  }),
  change({
    type: "bug", commit: "47cfe13", source: "QA edge check (slow network)", roles: ["student"],
    title: "Start Test button waits until the page is ready",
    body: "TODO-EDIT: On a slow connection the Start Test button stays disabled and shows Loading... until the test is ready, so clicking it early no longer does nothing.",
  }),
];

for (const e of entries) {
  if (DRY) { console.log(JSON.stringify(e)); continue; }
  console.log(`${await writeEntry(e)}  ${e.kind}  ${e.title}`);
}
