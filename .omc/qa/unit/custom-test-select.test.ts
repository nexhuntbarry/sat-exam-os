// node --experimental-strip-types .omc/qa/unit/custom-test-select.test.ts
// Custom test selection (lib/custom-test/rules + select, plan section E):
// domain / skill / difficulty allocation, adaptive module sizes, the skill
// cap over what one student sees, de-duplication of copies and repeated
// passages, the fallback chain and its shortfall messages, version
// exclusion (+ reuse), determinism, Replace, and the server-side checks.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import "./_resolve.ts";
if (!existsSync(new URL("../../../lib/custom-test/select.ts", import.meta.url))) {
  console.log("custom-test-select: skipped (lib/custom-test not on this branch)");
  process.exit(0);
}
const R = await import("../../../lib/custom-test/rules.ts");
const Sel = await import("../../../lib/custom-test/select.ts");
const { canonicalSkill, SAT_DOMAINS, domainsOf } = await import("../../../lib/sat-skills.ts");
const { dupKey, ineligibleReason } = await import("../../../lib/custom-test/pool.ts");
type PoolQuestion = import("../../../lib/custom-test/select.ts").PoolQuestion;
type CustomRules = import("../../../lib/custom-test/rules.ts").CustomRules;
type Difficulty = import("../../../lib/custom-test/rules.ts").Difficulty;

// ---- official skills
assert.equal(SAT_DOMAINS.filter((d) => d.section === "Reading & Writing").flatMap((d) => d.skills).length, 11);
assert.equal(SAT_DOMAINS.filter((d) => d.section === "Math").flatMap((d) => d.skills).length, 19);
for (const s of ["Reading & Writing", "Math"] as const) assert.equal(domainsOf(s).reduce((a, d) => a + d.weight, 0), 100);
// Stored labels → official skill; the official skill's domain wins.
const C = (sec: string, dom: string, sk: string, q = false) => canonicalSkill(sec, dom, sk, { quantitative: q });
assert.deepEqual(C("Reading & Writing", "Information and Ideas", "Words in Context"), { domain: "Craft and Structure", skill: "Words in Context" });
assert.deepEqual(C("Reading & Writing", "Craft and Structure", "Transitions"), { domain: "Expression of Ideas", skill: "Transitions" });
assert.equal(C("Reading & Writing", "Information and Ideas", "Command of Evidence").skill, "Command of Evidence: Textual");
assert.equal(C("Reading & Writing", "Information and Ideas", "Command of Evidence", true).skill, "Command of Evidence: Quantitative");
assert.equal(C("Reading & Writing", "Standard English Conventions", "Punctuation").skill, "Boundaries");
assert.equal(C("Reading & Writing", "Standard English Conventions", "Subject-Verb Agreement").skill, "Form, Structure, and Sense");
assert.equal(C("Reading & Writing", "Information and Ideas", "Literary Analysis").skill, "Other (Information and Ideas)");
assert.equal(C("Math", "Algebra", "Linear equations in one variable").skill, "Linear equations in one variable");
assert.equal(C("Math", "Algebra", "Systems of linear equations").skill, "Systems of two linear equations in two variables");
assert.equal(C("Math", "Advanced Math", "Systems of equations").skill, "Nonlinear equations in one variable and systems of equations in two variables");
assert.equal(C("Math", "Advanced Math", "Evaluating functions").skill, "Nonlinear functions");
assert.equal(C("Math", "Algebra", "Evaluating functions").skill, "Linear functions");
assert.equal(C("Math", "Advanced Math", "Polynomial operations").skill, "Equivalent expressions", "not 'ope-ratio-ns'");
assert.deepEqual(C("Math", "Problem Solving and Data Analysis", "Linear equations in two variables"), { domain: "Algebra", skill: "Linear equations in two variables" });
assert.deepEqual(C("Math", "Problem Solving and Data Analysis", "Percentages"), { domain: "Problem-Solving and Data Analysis", skill: "Percentages" });
assert.equal(C("Math", "Geometry and Trigonometry", "Similar triangles and proportional reasoning").skill, "Lines, angles, and triangles");
assert.equal(C("Math", "Geometry and Trigonometry", "Volume and unit conversion").skill, "Area and volume");
assert.equal(C("Math", "Problem Solving and Data Analysis", "Interpreting bar charts").skill, "Other (Problem-Solving and Data Analysis)");

// ---- arithmetic
assert.deepEqual(R.apportion(10, [["a", 26], ["b", 28], ["c", 20], ["d", 26]]), { a: 3, b: 3, c: 2, d: 2 });
assert.deepEqual(R.apportion(27, [["a", 26], ["b", 28], ["c", 20], ["d", 26]]), { a: 7, b: 8, c: 5, d: 7 });
assert.deepEqual(R.partStages("rw", { questions: 27, adaptive: false }), [{ key: "m1", n: 27 }], "single-subject fixed = one module");
assert.deepEqual(R.partStages("math", { questions: 21, adaptive: true }), [{ key: "m1", n: 11 }, { key: "m2_easy", n: 10 }, { key: "m2_hard", n: 10 }]);
assert.deepEqual(R.partStages("both", { questions: 9, adaptive: false }), [{ key: "m1", n: 5 }, { key: "m2", n: 4 }], "R&W + Math always two modules");
assert.equal(R.suggestedMinutes("rw", 27), 32, "27 × 71 s = 31.95 → 32");
assert.equal(R.suggestedMinutes("math", 22), 35, "22 × 95 s = 34.8 → 35");
assert.equal(R.suggestedMinutes("math", 1), 2);
assert.deepEqual(R.suggestedPartMinutes("both", "rw", { questions: 54, adaptive: true }), { m1: 32, m2: 32 });
assert.equal(R.minQuestions("both", false), 4);
assert.equal(R.minQuestions("rw", true), 6);
assert.equal(R.minQuestions("math", false), 1);
assert.deepEqual(R.difficultyQuotas({ Easy: 30, Medium: 40, Hard: 30 }, 22), { Easy: 7, Medium: 9, Hard: 6 });
// Even spread: cap 1 while small, raised only when needed.
const small = R.defaultSkillCounts("rw", 10);
assert.equal(R.skillTotal(small), 10);
assert.equal(R.skillCap({ skills: small }), 1);
const big = R.defaultSkillCounts("rw", 27);
assert.equal(R.skillTotal(big), 27);
assert.equal(R.skillCap({ skills: big }), 4, "27 R&W over 11 skills needs up to 4 (Expression of Ideas has 2 skills)");
// Skills with no questions are skipped when spreading.
const noTransitions = R.defaultSkillCounts("rw", 10, { "Expression of Ideas": { "Rhetorical Synthesis": { Easy: 5, Medium: 5, Hard: 5 } } });
assert.equal(noTransitions["Expression of Ideas"]["Transitions"], 0);
assert.equal(noTransitions["Expression of Ideas"]["Rhetorical Synthesis"], 2);

// ---- rules validation
// Times as for R&W + Math (two modules); a single-subject test ignores Module 2's.
const part = (key: "rw" | "math", n: number, adaptive = false) => {
  const p = R.defaultPart("rw", key);
  p.questions = n;
  p.adaptive = adaptive;
  p.skills = R.defaultSkillCounts(key, n);
  p.minutes = R.suggestedPartMinutes("both", key, p);
  return p;
};
const rules = (subject: "rw" | "math" | "both", parts: CustomRules["parts"]): CustomRules => ({
  v: 1, subject, order: R.partsOf(subject), break: null, parts, seed: "", family_id: "", version: 1,
});
assert.deepEqual(R.rulesErrors(rules("rw", { rw: part("rw", 10) })), []);
assert.match(R.rulesErrors(rules("rw", { rw: part("rw", 4, true) })).join(), /6–54 for an adaptive part/);
assert.match(R.rulesErrors(rules("both", { rw: part("rw", 3), math: part("math", 10) })).join(), /4–54/);
{
  const p = part("math", 10);
  p.skills.Algebra["Linear functions"] += 1;
  assert.match(R.rulesErrors(rules("math", { math: p })).join(), /adds up to 11, not 10/);
  const q = part("math", 10);
  q.mix.all = { Easy: 50, Medium: 40, Hard: 20 };
  assert.match(R.rulesErrors(rules("math", { math: q })).join(), /add up to 100%/);
  const s = part("math", 10);
  (s.skills.Algebra as Record<string, number>)["Made-up skill"] = 0;
  assert.match(R.rulesErrors(rules("math", { math: s })).join(), /unknown skill/);
}
assert.match(R.rulesErrors({ ...rules("both", { rw: part("rw", 10), math: part("math", 10) }), break: { minutes: 61, allowPause: false } }).join(), /Break must be 0–60/);
assert.deepEqual(R.rulesErrors({ ...rules("both", { rw: part("rw", 10), math: part("math", 10) }), break: { minutes: 0, allowPause: false } }), []);
assert.equal(R.normalizeRules({ ...rules("both", { rw: part("rw", 10), math: part("math", 10) }), break: { minutes: 0, allowPause: true } }).break, null, "0 = no break");

// ---- a synthetic bank
let n = 0;
function bank(): PoolQuestion[] {
  const out: PoolQuestion[] = [];
  for (const d of SAT_DOMAINS) {
    const key = d.section === "Math" ? "math" : "rw";
    for (const s of d.skills) {
      for (const diff of ["Easy", "Medium", "Hard"] as Difficulty[]) {
        for (let i = 0; i < 6; i++) out.push({ id: `q${++n}`, part: key, domain: d.name, skill: s, difficulty: diff, dupKey: `k${n}` });
      }
    }
  }
  return out;
}
const pool = bank();
const byId = new Map(pool.map((q) => [q.id, q]));
const ids = (s: import("../../../lib/custom-test/select.ts").Selection) => Sel.selectionIds(s);

// Fixed single subject: exact per-skill counts, difficulty quotas, no repeats.
{
  const r = rules("rw", { rw: part("rw", 27) });
  const s = Sel.buildSelection(pool, r, { seed: "a" });
  assert.deepEqual(s.shortfalls, []);
  const list = s.parts.rw![0].questionIds;
  assert.equal(list.length, 27);
  assert.equal(new Set(list).size, 27);
  for (const [d, skills] of Object.entries(r.parts.rw!.skills)) for (const [sk, c] of Object.entries(skills)) {
    assert.equal(list.filter((id) => byId.get(id)!.skill === sk && byId.get(id)!.domain === d).length, c, `${sk} count`);
  }
  const diff = (d: string) => list.filter((id) => byId.get(id)!.difficulty === d).length;
  assert.deepEqual([diff("Easy"), diff("Medium"), diff("Hard")], [8, 11, 8], "30/40/30 of 27");
  // R&W order: official domain order, then difficulty.
  const domRank = (id: string) => domainsOf("Reading & Writing").findIndex((d) => d.name === byId.get(id)!.domain);
  for (let i = 1; i < list.length; i++) assert.ok(domRank(list[i - 1]) <= domRank(list[i]), "domain order");
  assert.deepEqual(Sel.selectionErrors(pool, r, s), []);
  // Same seed, same test; a new seed, a different one.
  assert.deepEqual(Sel.buildSelection(pool, r, { seed: "a" }), s);
  assert.notDeepEqual(ids(Sel.buildSelection(pool, r, { seed: "b" })), ids(s));
}

// Adaptive: M1 = ceil(N/2), each M2 the rest; mixes per module; cap over M1 ∪ M2.
{
  const p = part("math", 22, true);
  const r = rules("math", { math: p });
  const s = Sel.buildSelection(pool, r, { seed: "ad" });
  const [m1, me, mh] = s.parts.math!;
  assert.deepEqual([m1.key, me.key, mh.key], ["m1", "m2_easy", "m2_hard"]);
  assert.deepEqual([m1.questionIds.length, me.questionIds.length, mh.questionIds.length], [11, 11, 11]);
  assert.equal(new Set(ids(s)).size, 33, "no question twice, even across the two Module 2 tracks");
  const hard = (l: string[]) => l.filter((id) => byId.get(id)!.difficulty === "Hard").length;
  assert.ok(hard(mh.questionIds) > hard(me.questionIds), "harder Module 2 is harder");
  const cap = R.skillCap(p);
  for (const m2 of [me, mh]) {
    const count = new Map<string, number>();
    for (const id of [...m1.questionIds, ...m2.questionIds]) count.set(byId.get(id)!.skill, (count.get(byId.get(id)!.skill) ?? 0) + 1);
    for (const v of count.values()) assert.ok(v <= cap, "cap over what one student sees");
    // Each student's M1 + M2 is exactly the part's skill counts.
    for (const [, skills] of Object.entries(p.skills)) for (const [sk, c] of Object.entries(skills)) assert.equal(count.get(sk) ?? 0, c);
  }
  assert.deepEqual(Sel.selectionErrors(pool, r, s), []);
}

// De-duplication: copies (same dupKey) and repeated passages never twice.
{
  const dupPool = pool.map((q) => (q.part === "rw" ? { ...q, dupKey: `${q.domain}:${q.skill}:${q.difficulty}` } : q));
  // Every cell now has 6 copies of one passage → at most one per cell.
  const r = rules("rw", { rw: part("rw", 27) });
  const s = Sel.buildSelection(dupPool, r, { seed: "d" });
  const keys = ids(s).map((id) => dupPool.find((q) => q.id === id)!.dupKey);
  assert.equal(new Set(keys).size, keys.length, "no duplicate key twice");
  // A hand-built selection with two copies is refused on save.
  const twin = dupPool.filter((q) => q.dupKey === keys[0]).map((q) => q.id).slice(0, 2);
  const bad = { parts: { rw: [{ key: "m1" as const, questionIds: [...twin] }] }, shortfalls: [] };
  const r2 = rules("rw", { rw: { ...part("rw", 2), skills: { ...R.defaultSkillCounts("rw", 2) } } });
  assert.match(Sel.selectionErrors(dupPool, r2, bad).join(), /is a copy of/);
  // Pool-level dup keys: R&W shares a passage, Math needs the same stem and choices.
  const passage = "The old lighthouse keeper wrote in his journal every evening for forty years, describing the sea, the weather, the ships that passed, and the birds that rested on the gallery rail before storms. Historians now read it as a record of the coast.";
  assert.equal(dupKey("rw", { question_text: `${passage} Which choice best states the main idea?`, choices: [] }), dupKey("rw", { question_text: `${passage}\n\nWhich choice best describes the function of the underlined sentence?`, choices: [] }));
  assert.notEqual(dupKey("math", { question_text: "What is 2+2?", choices: [{ text: "4" }] }), dupKey("math", { question_text: "What is 2+2?", choices: [{ text: "5" }] }));
  assert.equal(dupKey("math", { question_text: "What is <b>2+2</b>?", choices: [] }), dupKey("math", { question_text: "what is 2+2?", choices: [] }));
}

// Shortfall + fallback: Hard runs out → Medium of the same skill, reported.
{
  const thin = pool.filter((q) => !(q.skill === "Transitions" && q.difficulty === "Hard") && !(q.skill === "Rhetorical Synthesis" && q.difficulty === "Hard"));
  const p = part("rw", 27);
  p.mix.all = { Easy: 0, Medium: 0, Hard: 100 };
  const s = Sel.buildSelection(thin, rules("rw", { rw: p }), { seed: "f" });
  const sf = s.shortfalls.find((x) => x.domain === "Expression of Ideas")!;
  assert.ok(sf, "Expression of Ideas reported");
  assert.equal(sf.wanted, 5);
  assert.equal(sf.found, 0);
  assert.match(sf.message, /^Reading and Writing: asked for 5 Hard Expression of Ideas, found 0, 5 Medium\.$/);
  // Never crosses domains: Expression of Ideas is still 5 questions.
  assert.equal(ids(s).filter((id) => byId.get(id)!.domain === "Expression of Ideas").length, 5);
}
// An empty skill: the default split (built from the bank's counts) leaves it
// out and gives its share to the domain's other skills — no shortfall.
{
  const noBoundaries = pool.filter((q) => q.skill !== "Boundaries");
  const p = part("rw", 10);
  p.skills = R.defaultSkillCounts("rw", 10, Sel.poolCounts(noBoundaries, "rw"));
  assert.equal(p.skills["Standard English Conventions"]["Boundaries"], 0);
  assert.equal(p.skills["Standard English Conventions"]["Form, Structure, and Sense"], 2);
  const s = Sel.buildSelection(noBoundaries, rules("rw", { rw: p }), { seed: "g" });
  assert.deepEqual(s.shortfalls, []);
  assert.equal(ids(s).length, 10);
}
// Asked for explicitly anyway → another skill of the same domain while it
// has cap room, the rest left empty; both reported. The cap holds.
{
  const noBoundaries = pool.filter((q) => q.skill !== "Boundaries");
  const p = part("rw", 27);
  const conv = p.skills["Standard English Conventions"];
  assert.deepEqual([conv["Boundaries"], conv["Form, Structure, and Sense"], R.skillCap(p)], [4, 3, 4]);
  const s = Sel.buildSelection(noBoundaries, rules("rw", { rw: p }), { seed: "g" });
  const sf = s.shortfalls.filter((x) => x.domain === "Standard English Conventions").map((x) => x.message).join(" ");
  assert.match(sf, /1 from another Standard English Conventions skill/);
  assert.match(sf, /3 left empty/);
  assert.equal(ids(s).filter((id) => byId.get(id)!.skill === "Form, Structure, and Sense").length, 4, "up to the cap, no further");
  assert.deepEqual(Sel.selectionErrors(noBoundaries, rules("rw", { rw: p }), s), []);
}
// Nothing left in the domain → left empty, reported; the module is shorter.
{
  const noConv = pool.filter((q) => q.domain !== "Standard English Conventions");
  const s = Sel.buildSelection(noConv, rules("rw", { rw: part("rw", 10) }), { seed: "h" });
  assert.ok(s.shortfalls.some((x) => /left empty/.test(x.message)));
  assert.ok(s.parts.rw![0].questionIds.length < 10);
}

// Make another version: earlier versions' questions (and their copies) are left out.
{
  const r = rules("math", { math: part("math", 22, true) });
  const v1 = Sel.buildSelection(pool, r, { seed: "v1" });
  const used = new Set(ids(v1));
  const v2 = Sel.buildSelection(pool, r, { seed: "v2", exclude: used });
  assert.equal(ids(v2).filter((id) => used.has(id)).length, 0);
  assert.deepEqual(Sel.selectionErrors(pool, r, v2, { exclude: used }), []);
  assert.match(Sel.selectionErrors(pool, r, v1, { exclude: used }).join(), /used in an earlier version/);
  // A copy of an earlier question is left out too.
  const copyPool = [...pool, { ...byId.get([...used][0])!, id: "copy-of-used" }];
  assert.ok(!ids(Sel.buildSelection(copyPool, r, { seed: "v2", exclude: used })).includes("copy-of-used"));
  // Pool too small without reuse → shortfall; with reuse ticked → refilled from earlier versions.
  const tiny = pool.filter((q) => q.part === "math").slice(0, 120);
  const t1 = Sel.buildSelection(tiny, r, { seed: "t1" });
  const t2 = Sel.buildSelection(tiny, r, { seed: "t2", exclude: new Set(ids(t1)) });
  const t3 = Sel.buildSelection(tiny, r, { seed: "t2", exclude: new Set(ids(t1)), allowReuse: true });
  assert.ok(ids(t3).length >= ids(t2).length);
  assert.deepEqual(Sel.selectionErrors(tiny, r, t3, { exclude: new Set(ids(t1)), allowReuse: true }), []);
  // Counts per cell leave the excluded ones out.
  const counts = Sel.poolCounts(pool, "math", used);
  const total = Object.values(counts).flatMap((d) => Object.values(d)).reduce((a, m) => a + m.Easy + m.Medium + m.Hard, 0);
  assert.equal(total, pool.filter((q) => q.part === "math").length - used.size);
}

// Replace: same skill and difficulty, test otherwise unchanged.
{
  const r = rules("rw", { rw: part("rw", 12, true) });
  const s = Sel.buildSelection(pool, r, { seed: "r" });
  const target = s.parts.rw![1].questionIds[0];
  const out = Sel.replaceQuestion(pool, r, s, { part: "rw", questionId: target }, { seed: "r2" });
  assert.ok(!("error" in out));
  if (!("error" in out)) {
    const after = out.selection.parts.rw![1].questionIds;
    const newId = after.find((id) => !s.parts.rw![1].questionIds.includes(id))!;
    assert.equal(after.length, s.parts.rw![1].questionIds.length);
    assert.equal(byId.get(newId)!.skill, byId.get(target)!.skill);
    assert.equal(byId.get(newId)!.difficulty, byId.get(target)!.difficulty);
    assert.equal(out.note, null);
    assert.ok(!ids(s).includes(newId), "never a question already in the test");
    assert.deepEqual(Sel.selectionErrors(pool, r, out.selection), []);
  }
  assert.match(JSON.stringify(Sel.replaceQuestion(pool, r, s, { part: "rw", questionId: "nope" }, { seed: "x" })), /isn't in this test/);
  // A saved question that is no longer eligible can be replaced from its cell.
  const gone = s.parts.rw![0].questionIds[0];
  const without = pool.filter((q) => q.id !== gone);
  const out2 = Sel.replaceQuestion(without, r, s, { part: "rw", questionId: gone, info: byId.get(gone)! }, { seed: "y" });
  assert.ok(!("error" in out2));
}

// Server-side checks on save.
{
  const r = rules("rw", { rw: part("rw", 6) });
  const s = Sel.buildSelection(pool, r, { seed: "s" });
  const gone = s.parts.rw![0].questionIds[0];
  assert.match(Sel.selectionErrors(pool.filter((q) => q.id !== gone), r, s).join(), /no longer eligible/);
  assert.match(Sel.selectionErrors(pool, r, { parts: { rw: [{ key: "m1", questionIds: [...s.parts.rw![0].questionIds, pool.find((q) => q.part === "rw" && !ids(s).includes(q.id))!.id] }] }, shortfalls: [] }).join(), /rules allow 6/);
  const math = pool.find((q) => q.part === "math")!.id;
  assert.match(Sel.selectionErrors(pool, r, { parts: { rw: [{ key: "m1", questionIds: [math] }] }, shortfalls: [] }).join(), /no longer eligible/, "wrong section");
  assert.match(Sel.selectionErrors(pool, r, { parts: { rw: [{ key: "m1", questionIds: [] }] }, shortfalls: [] }).join(), /has no questions/);
  assert.match(Sel.selectionErrors(pool, r, { parts: { rw: [{ key: "m2", questionIds: ["x"] }] }, shortfalls: [] }).join(), /don't match/);
  // Cap: 3 of one skill for a cap of 1.
  const three = pool.filter((q) => q.skill === "Inferences").slice(0, 3).map((q) => q.id);
  assert.match(Sel.selectionErrors(pool, r, { parts: { rw: [{ key: "m1", questionIds: three }] }, shortfalls: [] }).join(), /Inferences has 3 questions for one student; the cap is 1/);
}

// R&W + Math: both parts, two modules each, no repeats across the test.
{
  const r = rules("both", { rw: part("rw", 54), math: part("math", 44, true) });
  const s = Sel.buildSelection(pool, r, { seed: "both" });
  assert.deepEqual(s.parts.rw!.map((x) => x.questionIds.length), [27, 27]);
  assert.deepEqual(s.parts.math!.map((x) => x.questionIds.length), [22, 22, 22]);
  assert.equal(new Set(ids(s)).size, ids(s).length);
  assert.deepEqual(Sel.selectionErrors(pool, r, s), []);
}

// ---- eligibility
const okRow = {
  id: "x", module_id: "m", section: "Math", domain: "Algebra", skill: "Linear functions", difficulty: "Easy", parsing_status: "Approved",
  parsing_notes: null, correct_answer: "A", question_text: "What?", choices: [{ label: "A", text: "1" }], has_image: false, has_table: false, image_urls: [],
};
assert.equal(ineligibleReason(okRow), null);
assert.match(String(ineligibleReason({ ...okRow, parsing_status: "Needs Review" })), /not Approved/);
assert.match(String(ineligibleReason({ ...okRow, parsing_notes: "Needs review: AI thinks the answer key may be wrong (stored A, AI suggests B) — x. Check the official answer before approving." })), /review queue/);
assert.match(String(ineligibleReason({ ...okRow, parsing_notes: "[live-fix] fixed in a live test" })), /review queue/);
assert.match(String(ineligibleReason({ ...okRow, difficulty: null })), /missing/);
assert.match(String(ineligibleReason({ ...okRow, skill: " " })), /missing/);
assert.match(String(ineligibleReason({ ...okRow, correct_answer: "" })), /no answer key/);
assert.match(String(ineligibleReason({ ...okRow, has_image: true, image_urls: [], choices: [{ label: "A", text: "1" }] })), /figure missing/);
assert.match(
  String(ineligibleReason({ ...okRow, choices: [{ label: "A", text: "", image_url: "https://x/a.png" }, { label: "B", text: "" }] })),
  /graph choices/,
);

console.log("custom-test-select: all assertions passed");
