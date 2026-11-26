// node --experimental-strip-types .omc/qa/unit/test-pairing.test.ts
// Ticket f7276162: which R&W and Math tests make one set (one total) —
// lib/test-pairing pairSections, used by the one-page report, the student
// pages' chart / recent tests, the old PDF report and the class Scores grid.
// Name match across days, same-day fallback, admin override (set / "no
// pair" / cleared), full-length untouched, one section only, two sets on
// one day kept apart by name, retakes, set names and chart labels.
import assert from "node:assert/strict";
import "./_resolve.ts";
const P = await import("../../../lib/test-pairing.ts");
const R = await import("../../../lib/one-page-report.ts");
const { placeLabels } = await import("../../../lib/chart-labels.ts");
type Occasion = import("../../../lib/score-analysis.ts").Occasion;
type PairItem = import("../../../lib/test-pairing.ts").PairItem;

const { PAIR_RW: RW, PAIR_MATH: MATH } = P;
const item = (testId: string, testName: string, section: typeof RW | typeof MATH, date: string): PairItem & { id: string } => ({
  id: `${testId}@${date}`,
  testId,
  testName,
  section,
  date,
});
const ids = (s: { rw: { id: string } | null; math: { id: string } | null }) => [s.rw?.id ?? null, s.math?.id ?? null];

// ── normalizeSetName ──────────────────────────────────────────────────
assert.equal(P.normalizeSetName("Nov 26 SAT Intensive Math day 1"), "Nov 26 SAT Intensive day 1");
assert.equal(P.normalizeSetName("Nov 26 SAT Intensive Eng day 1"), "Nov 26 SAT Intensive day 1");
assert.equal(P.normalizeSetName("Nov 26 SAT Intensive RW day 3"), "Nov 26 SAT Intensive day 3");
assert.equal(P.normalizeSetName("[Fall 2026 SAT Midterm] [Test #19] SAT ENG Test"), "[Fall 2026 SAT Midterm] [Test #19] SAT Test");
assert.equal(P.normalizeSetName("[Fall 2026 SAT Midterm] [Test #19] SAT Math Test"), "[Fall 2026 SAT Midterm] [Test #19] SAT Test");
assert.equal(P.normalizeSetName("Practice 3 - Reading and Writing"), "Practice 3");
assert.equal(P.normalizeSetName("Practice 3 – reading & writing"), "Practice 3");
assert.equal(P.normalizeSetName("Practice 3 (R&W)"), "Practice 3");
assert.equal(P.normalizeSetName("English Practice 3"), "Practice 3");
assert.equal(P.normalizeSetName("2025-09-MAth-Module 1 Test"), "2025-09-Module 1 Test");
// Subject words only as whole words: "Engine", "Mathews", "Rwanda" stay.
assert.equal(P.normalizeSetName("Engine Mathews Rwanda Test"), "Engine Mathews Rwanda Test");
assert.equal(P.setNameKey("[Test #19] SAT  Test"), P.setNameKey("[test #19] sat test"));
assert.equal(P.setNameKey("Math"), "", "a name that is only a subject has no set name");

// ── Name match across different days (Joshua, ticket f7276162) ─────────
{
  const items = [
    item("m1", "Nov 26 SAT Intensive Math day 1", MATH, "2026-11-18T00:39:53Z"), // 11/17 NY
    item("m3", "Nov 26 SAT Intensive Math day 3", MATH, "2026-11-18T23:03:35Z"),
    item("r3", "Nov 26 SAT Intensive RW day 3", RW, "2026-11-19T01:18:46Z"),
    item("r2", "Nov 26 SAT Intensive Eng day 2", RW, "2026-11-22T15:48:01Z"),
    item("m2", "Nov 26 SAT Intensive Math day 2", MATH, "2026-11-22T19:02:27Z"),
    item("r1", "Nov 26 SAT Intensive Eng day 1", RW, "2026-11-25T03:25:58Z"), // 11/24 NY
  ];
  const sets = P.pairSections(items);
  assert.deepEqual(sets.map((s) => s.name), ["Nov 26 SAT Intensive day 3", "Nov 26 SAT Intensive day 2", "Nov 26 SAT Intensive day 1"]);
  assert.ok(sets.every((s) => s.via === "name" && s.rw && s.math));
  // Set date = when the later section was finished; order by it.
  assert.equal(sets[2].date, "2026-11-25T03:25:58Z");
  assert.deepEqual(ids(sets[2]), ["r1@2026-11-25T03:25:58Z", "m1@2026-11-18T00:39:53Z"]);
  assert.deepEqual(P.shortSetLabels(sets.map((s) => s.name)), ["Day 3", "Day 2", "Day 1"]);
}

// ── Same-day fallback (names don't match) ─────────────────────────────
{
  const sets = P.pairSections([
    item("a", "SAT R&W Assesment", RW, "2026-11-03T14:00:00Z"),
    item("b", "SAT Math Assessment", MATH, "2026-11-04T03:00:00Z"), // 11 pm NY, same day
    item("c", "Quiz Math 7", MATH, "2026-11-10T14:00:00Z"),
  ]);
  assert.equal(sets.length, 2);
  assert.equal(sets[0].via, "day");
  assert.equal(sets[0].name, null, "a same-day pair of differently named tests has no set name");
  assert.deepEqual(ids(sets[0]), ["a@2026-11-03T14:00:00Z", "b@2026-11-04T03:00:00Z"]);
  assert.equal(sets[1].rw, null, "one section only: no pair");
  assert.equal(sets[1].name, "Quiz 7");
}

// ── Two sets on the same day: matched by name, not mixed ──────────────
{
  const day = (h: number) => `2026-11-20T${String(h).padStart(2, "0")}:00:00Z`;
  const sets = P.pairSections([
    item("ra", "Set A English", RW, day(14)),
    item("rb", "Set B English", RW, day(15)),
    item("ma", "Set A Math", MATH, day(16)),
    item("mb", "Set B Math", MATH, day(17)),
  ]);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map(ids), [
    [`ra@${day(14)}`, `ma@${day(16)}`],
    [`rb@${day(15)}`, `mb@${day(17)}`],
  ]);
  assert.ok(sets.every((s) => s.via === "name"));
}

// ── Single section only: never a total ────────────────────────────────
{
  const sets = P.pairSections([item("m1", "Intensive Math day 1", MATH, "2026-11-01T15:00:00Z")]);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].rw, null);
  assert.ok(sets[0].math);
}

// ── Retake: the latest attempt of a section in the set counts ─────────
{
  const sets = P.pairSections([
    item("m1", "Intensive Math day 1", MATH, "2026-11-01T15:00:00Z"),
    item("m1", "Intensive Math day 1", MATH, "2026-11-05T15:00:00Z"),
    item("r1", "Intensive Eng day 1", RW, "2026-11-03T15:00:00Z"),
  ]);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].math!.id, "m1@2026-11-05T15:00:00Z");
  assert.equal(sets[0].date, "2026-11-05T15:00:00Z");
}

// ── Admin override: set, "no pair", cleared ───────────────────────────
{
  const items = [
    item("m1", "Intensive Math day 1", MATH, "2026-11-01T15:00:00Z"),
    item("r1", "Intensive Eng day 1", RW, "2026-11-08T15:00:00Z"),
    item("rx", "Make-up Reading and Writing", RW, "2026-11-09T15:00:00Z"),
  ];
  // Set: m1 ↔ rx (stored on one side only still reads symmetric).
  const set = P.pairSections(items, new Map([["m1", "rx"]]));
  const paired = set.find((s) => s.via === "override")!;
  assert.deepEqual(ids(paired), ["rx@2026-11-09T15:00:00Z", "m1@2026-11-01T15:00:00Z"]);
  assert.equal(paired.name, "Make-up + Intensive day 1");
  const r1 = set.find((s) => s.rw?.testId === "r1")!;
  assert.equal(r1.math, null, "r1 lost its name partner to the override");
  // Explicitly no pair on m1: m1 never pairs, not by name, not by day.
  const none = P.pairSections(
    [...items, item("rd", "Other R&W", RW, "2026-11-01T18:00:00Z")], // same NY day as m1
    new Map([["m1", null]]),
  );
  const m1 = none.find((s) => s.math?.testId === "m1")!;
  assert.equal(m1.rw, null);
  assert.ok(none.every((s) => !(s.rw && s.math)), "no set has both sections");
  // Cleared (back to automatic): the name match is back.
  const auto = P.pairSections(items, new Map());
  assert.deepEqual(ids(auto.find((s) => s.via === "name")!), ["r1@2026-11-08T15:00:00Z", "m1@2026-11-01T15:00:00Z"]);
  // An override whose partner the student hasn't taken: the test stands alone.
  const alone = P.pairSections(items.slice(0, 2), new Map([["m1", "never-taken"]]));
  assert.ok(alone.every((s) => !(s.rw && s.math)));
}

// ── parsePairing (tests.pairing values) ───────────────────────────────
assert.equal(P.parsePairing(null), undefined);
assert.equal(P.parsePairing({}), undefined);
assert.equal(P.parsePairing({ test_id: null }), null);
assert.equal(P.parsePairing({ test_id: "abc" }), "abc");
assert.equal(P.isPairingColumnMissing({ code: "42703", message: "column tests.pairing does not exist" }), true);
assert.equal(P.isPairingColumnMissing({ code: "42703", message: "column tests.other does not exist" }), false);
assert.equal(
  P.autoPartnerByName("Intensive Math day 1", [
    { id: "x", name: "Intensive Eng day 2" },
    { id: "y", name: "Intensive Eng day 1" },
  ])?.id,
  "y",
);

// ── buildAssessments: full-length untouched, override via occasions ───
function occ(date: string, section: string, sat: number, label: string, opts: { testKey?: string; testId?: string; pairWith?: string | null } = {}): Occasion {
  return {
    date,
    section,
    label,
    rows: [{ is_correct: true, section, domain: section === MATH ? "Algebra" : "Craft and Structure" }],
    testKey: opts.testKey ?? `s:${label}:${date}`,
    testId: opts.testId ?? label,
    ...(opts.pairWith !== undefined ? { pairWith: opts.pairWith } : {}),
    submissionIds: [`sub:${label}:${date}`],
    score: { sat, modules: "", pct: null, notes: [] },
    scaledScore: sat,
  };
}
{
  const list = R.buildAssessments([
    // Full-length SAT named like a set: keeps its own total, never pairs with section tests.
    occ("2026-10-01T15:00:00Z", RW, 650, "Practice SAT 1 Reading and Writing", { testKey: "fl:p:s:1" }),
    occ("2026-10-01T17:30:00Z", MATH, 700, "Practice SAT 1 Math", { testKey: "fl:p:s:1" }),
    occ("2026-10-02T15:00:00Z", MATH, 600, "Practice SAT 1 Math section drill"),
    // Name match across days.
    occ("2026-11-18T00:39:53Z", MATH, 720, "Nov 26 SAT Intensive Math day 1"),
    occ("2026-11-25T03:25:58Z", RW, 690, "Nov 26 SAT Intensive Eng day 1"),
  ]);
  assert.equal(list.length, 3);
  assert.equal(list[0].kind, "full");
  assert.equal(list[0].total, 1350);
  assert.equal(list[1].kind, "section");
  assert.equal(list[1].total, null);
  assert.equal(list[2].kind, "pair");
  assert.equal(list[2].total, 1410);
  assert.equal(list[2].name, "Nov 26 SAT Intensive day 1");
  assert.deepEqual(R.sectionDates(list[2]), ["2026-11-18T00:39:53Z", "2026-11-25T03:25:58Z"]);
  // A teacher of one subject: no totals at all.
  assert.ok(R.buildAssessments([occ("2026-11-18T00:39:53Z", MATH, 720, "Day Math 1"), occ("2026-11-25T03:25:58Z", RW, 690, "Day Eng 1")], [MATH]).every((a) => a.total == null));
  // Override carried on the occasions: "no pair" on the Math test.
  const none = R.buildAssessments([
    occ("2026-11-18T00:39:53Z", MATH, 720, "Nov 26 SAT Intensive Math day 1", { pairWith: null }),
    occ("2026-11-25T03:25:58Z", RW, 690, "Nov 26 SAT Intensive Eng day 1"),
  ]);
  assert.ok(none.every((a) => a.total == null));
}

// ── shortSetLabels ────────────────────────────────────────────────────
assert.deepEqual(
  P.shortSetLabels(["[Fall 2026 SAT Midterm] [Test #19] SAT Test", "[Fall 2026 SAT Midterm] [Test #20] SAT Test", null]),
  ["Test #19", "Test #20", null],
);
assert.deepEqual(P.shortSetLabels(["Practice 3"]), ["Practice 3"], "alone: the whole name");
assert.ok(P.shortSetLabels(["A very long set name that goes on and on"])[0]!.length <= P.SET_LABEL_MAX);

// ── Chart labels: a lone dot's label moves below when a line runs through the spot above ──
{
  // Line climbing steeply right of the dot at (100, 100).
  const seg = [{ x1: 100, y1: 100, x2: 110, y2: 60 }];
  const y = placeLabels([{ id: "a", x: 100, dotY: 100, text: "610" }], {}, { segments: seg }).get("a")!;
  assert.ok(y > 100, "below the dot");
  const free = placeLabels([{ id: "a", x: 100, dotY: 100, text: "610" }], {}, { segments: [{ x1: 100, y1: 100, x2: 200, y2: 140 }] }).get("a")!;
  assert.ok(free < 100, "above when the line goes down");
}

console.log("test-pairing: all assertions passed");
