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
    body: "On the question review page, Next and Approve & Next now go on to the next module that still has Draft / Needs Review questions (wrapping around), instead of dropping you back on the module page.",
  }),
  change({
    type: "bug", commit: "6af4c49", source: "Report a Problem", ticket_id: "33feaba1-a0e0-49b3-a937-60a16e72148b",
    roles: ["student", "teacher", "admin"], verified: NIGHTLY,
    title: "Question figures: tighter crops, graph answer choices, no answer hints in image text",
    body: "Figure crops now stay inside the question's own area (no headers, question bars, ✓ marks, answer boxes or other questions); a crop that could still touch a ✓ goes to Needs Review. Graph answer choices show only the graph under A/B/C/D, with no text description. Image descriptions (alt text) are no longer sent to students. Re-cropping can no longer wipe an existing figure.",
  }),
  {
    kind: "bank_change", date: DATE, ticket_id: "33feaba1-a0e0-49b3-a937-60a16e72148b", rescored: 0,
    title: "Question images re-cropped and graph-choice questions fixed",
    body: "43 question images replaced, 10 removed, 4 questions now use graphs as answer choices, and 2 fill-in (student-produced response) questions had stray answer choices cleared.",
  },
  change({
    type: "feature", commit: "6af4c49", source: "Report a Problem", ticket_id: "d73e7fa4-8e2f-407b-bb9c-e5469ec29b3d",
    roles: ["teacher", "admin"],
    title: "Test progress counts per student",
    body: "The test page and the Tests list now count students, not module rows: a Math test with Module 1 + 2 used to count each student twice (Test #20 showed 4/4 for 2 students). Now: finished students / all assigned students (individual + class).",
  }),
  change({
    type: "feature", commit: "9ad167d", source: "Report a Problem (Barry approved)", ticket_id: "b34191b0-3c68-41d1-8b2f-7b9238777bf4",
    roles: ["admin"],
    title: "Crop or delete question images on the review page",
    body: "Each extracted image on the question review page has Crop (drag a box, save) and Delete (with confirmation). Changes save immediately; if someone else changed the image meanwhile you get a refresh message instead of overwriting.",
  }),
  change({
    type: "bug", commit: "6cb96f2", source: "Barry's request", roles: ["student", "teacher"],
    title: "Moving a due date mid-exam no longer marks an on-time exam Late",
    body: "If an admin moves the due date earlier while a student is taking the test, a student who started before the due date and finishes within the time limit is Submitted, not Late. Module 2 counts from Module 1's start.",
  }),
  change({
    type: "bug", commit: "c1d633e", source: "QA finding D-20261029-3", roles: ["student"],
    title: "Answers typed with a Chinese/Japanese keyboard are graded correctly",
    body: "Full-width digits and symbols (e.g. ３５, ６５／２) typed with a Chinese/Japanese input method are graded the same as normal ones. Checked all 7,043 saved answers: none were affected, so no rescoring was needed.",
  }),
  change({
    type: "bug", commit: "47cfe13", source: "QA edge check (slow network)", roles: ["student"],
    title: "Start Test button waits until the page is ready",
    body: "On a slow connection the Start Test button shows Loading... and stays disabled until the page is ready, so an early click no longer does nothing.",
  }),
  change({
    type: "bug", commit: "99460ee", source: "QA finding D-20261029-5", roles: ["student"], verified: ["D-20261029-5"],
    title: "Highlights made right before a refresh are kept",
    body: "A highlight or note made less than a second before a refresh, crash or closed tab used to disappear: the reloaded page overwrote it with an older copy. Highlights are now also kept on the student's device and restored when newer.",
  }),
  change({
    type: "bug", commit: "99460ee", source: "QA finding (new-tests job)", roles: ["student", "admin"],
    title: "On-time rule also applies to auto-submit and admin force-submit",
    body: "The automatic finalizer and admin force-submit now use the same rule as a student's own submit: an on-time student isn't marked Late because an admin moved the due date earlier.",
  }),
  change({
    type: "feature", commit: "082626f", source: "Report a Problem (Barry approved)", ticket_id: "05664488-8add-4c49-8c79-d2df7e16a303",
    roles: ["admin"],
    title: "Assign from the Tests list; reorganized test page",
    body: "Tests list: the Actions column has Assign (Students / Classes / Teachers) instead of View. Test page: one header with Assign / Edit / More, one summary row, the student list as the main section, answers & review controls side by side, settings collapsed. No feature works differently.",
  }),
  change({
    type: "feature", commit: "26c9374", source: "Report a Problem (Barry approved)", ticket_id: "bf9f172b-db0a-4a97-bf82-7997a2f75831",
    roles: ["admin"],
    title: "Students page: one list with status filters",
    body: "All students in one list with Status and Class columns, pending students on top with Approve / Reject in the row, a waiting banner, and filter chips with counts.",
  }),
  change({
    type: "feature", commit: "19efc16", source: "Report a Problem (Barry approved)", ticket_id: "611784a0-211a-4c01-afff-005462b956d4",
    roles: ["student", "admin"], verified: ["e2e-student-report"],
    title: "Students can report a problem on a question (off by default)",
    body: "A Report a problem button on each question (exam and results pages). Reports go to the admin Student Reports queue; an admin forwards to dev or dismisses. It doesn't touch the timer, answers or score. Turn it on from the Student Reports page.",
  }),
  change({
    type: "feature", commit: "20a46ae", source: "Report a Problem (Barry approved)", ticket_id: "5d2d208e-2cef-4ef4-a094-d41f0395b48c",
    roles: ["admin"],
    title: "Reports page: this running log",
    body: "QA runs, changes, question bank and score changes, and open items, for the current testing stage.",
  }),
  { kind: "open_item", date: DATE, waiting: "admin", ticket_id: "33feaba1-a0e0-49b3-a937-60a16e72148b",
    title: "Clean PDF needed: Test #19 Oct 2024 Math M2 Q22",
    body: "A student's handwriting is on the figure in the source PDF (√226, 155, m); 155 conflicts with the stated diameter 115. Upload a clean copy, or decide whether to remove the question from the test." },
  { kind: "open_item", date: DATE, waiting: "admin", ticket_id: "33feaba1-a0e0-49b3-a937-60a16e72148b",
    title: "Review and approve 4 graph-choice questions",
    body: "Test #25 March 2026 Math M2 Q7, Test #16 June 2024 A Math M2 Q1, Test #22 Dec 2024 B Math M1 Q9, and March 2026 Math M2 Q7 now have one graph image per choice. They stay Needs Review until an admin approves them." },
  { kind: "open_item", date: DATE, waiting: "admin",
    title: "Garbled source PDF: Aug 2025 Math M1 Q15 and M2 Q16",
    body: "The PDF prints axis labels as scrambled characters. Q15 can't be answered without them (also check its key, y = 1.7 + 0.7x). Needs a better source." },
];

for (const e of entries) {
  if (DRY) { console.log(JSON.stringify(e)); continue; }
  console.log(`${await writeEntry(e)}  ${e.kind}  ${e.title}`);
}
