// harness/fullsat-fixtures.mjs — QA fixtures for the full-length SAT
// nightly checks (nightly/fullsat-checks.mjs). Idempotent: every test is
// looked up by its exact name among QA-created tests first and only
// created when missing; ids are merged into .omc/qa/tests.json.
//
//   cd .omc/qa/harness && node fullsat-fixtures.mjs          (QA_BASE=… for another deploy)
//
// Creates, as TEST Admin 01 through the admin API (never touches real data):
//   flRwSource    TEST FL Source R&W (adaptive)   — Draft, unassigned; built from
//                 modules the QA baseline tests already serve (engLinear M1/M2 +
//                 untimedEng), so no bank module becomes "live" because of QA
//   flMathSource  the QA baseline `adaptive` test (reused when fully approved)
//   flFullLength  TEST FL Full-length SAT                    32/32/35/35, break 10
//   flShort       TEST FL Full-length SAT (2-min)            2-min modules, break 1
//   flPause       TEST FL Full-length SAT (2-min, pause)     2-min modules, break 2, pausing on
//   flWindow      TEST FL Full-length SAT (window close)     2-min modules, break 1
// The four full-length tests are Published, assigned to TEST Class A–E,
// show answers after submission, and allow no retakes (grants only).
// Needs migration 0031 on the target database and the Phase 0–3 code deployed.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { login, db, cast, BASE } from "./lib.mjs";

const TESTS_PATH = new URL("../tests.json", import.meta.url).pathname;
const TESTS = JSON.parse(readFileSync(TESTS_PATH, "utf-8"));
const C = cast();
const QA_ADMIN_IDS = C.admins.map((a) => a.id);
const CLASS_IDS = C.classes.map((k) => k.id);
const RW = "Reading & Writing";

const FULL_LENGTH = [
  { key: "flFullLength", name: "TEST FL Full-length SAT", limits: [32, 32, 35, 35], breakMinutes: 10, allowSectionPause: false },
  { key: "flShort", name: "TEST FL Full-length SAT (2-min)", limits: [2, 2, 2, 2], breakMinutes: 1, allowSectionPause: false },
  { key: "flPause", name: "TEST FL Full-length SAT (2-min, pause)", limits: [2, 2, 2, 2], breakMinutes: 2, allowSectionPause: true },
  { key: "flWindow", name: "TEST FL Full-length SAT (window close)", limits: [2, 2, 2, 2], breakMinutes: 1, allowSectionPause: false },
];
const RW_SOURCE_NAME = "TEST FL Source R&W (adaptive)";
const MATH_SOURCE_NAME = "TEST FL Source Math (adaptive)";

const log = (s) => console.log(s);
// Throws, so the finally below still closes the browser; reported at the end.
class Die extends Error {}
const die = (s) => { throw new Die(s); };

// ── prerequisites ──────────────────────────────────────────────
try {
  // Not a HEAD request: PostgREST reports a missing table/column only with a body.
  const a = await db.from("full_length_attempts").select("id").limit(1);
  const t = await db.from("tests").select("test_kind, parent_test_id").limit(1);
  if (a.error || t.error) die(`migration 0031 is not applied on this database (${(a.error ?? t.error).message})`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

/** Same rule as the publish gate (moduleApprovalError): every question Approved or Rejected, at least one Approved. */
async function fullyApproved(moduleIds) {
  const ids = [...new Set(moduleIds.filter(Boolean))];
  if (!ids.length) return false;
  // NOT IN skips NULL statuses, so those are read separately (a NULL is not approved).
  const [{ data: pending }, { data: unset }, { data: ok }] = await Promise.all([
    db.from("questions").select("module_id").in("module_id", ids).not("parsing_status", "in", "(Approved,Rejected)"),
    db.from("questions").select("module_id").in("module_id", ids).is("parsing_status", null),
    db.from("questions").select("module_id").in("module_id", ids).eq("parsing_status", "Approved"),
  ]);
  const p = new Set([...(pending ?? []), ...(unset ?? [])].map((q) => q.module_id));
  const a = new Set((ok ?? []).map((q) => q.module_id));
  return ids.every((id) => !p.has(id) && a.has(id));
}
async function sectionsOf(moduleIds) {
  const { data } = await db.from("modules").select("id, section, module_name").in("id", moduleIds.filter(Boolean));
  return new Map((data ?? []).map((m) => [m.id, m]));
}
/** A QA-created test with exactly this name, or null. */
async function qaTestByName(name) {
  const { data } = await db.from("tests").select("*").eq("test_name", name).in("created_by", QA_ADMIN_IDS);
  if ((data ?? []).length > 1) die(`${data.length} QA tests are named "${name}" — delete the extras first`);
  return data?.[0] ?? null;
}
const adaptiveIds = (t) => [t.module_1_id, t.module_2_easy_id, t.module_2_hard_id];

/**
 * Three distinct fully-approved modules of `section`, preferring the given
 * ones, then modules a Published QA-created test already serves. Never
 * borrows from real tests: QA must not make any real bank module "live"
 * (or depend on one) that isn't already served by a QA test.
 */
async function pickModules(section, preferred) {
  const chosen = [];
  const secs = await sectionsOf(preferred);
  for (const id of preferred) {
    if (id && !chosen.includes(id) && secs.get(id)?.section === section && (await fullyApproved([id]))) chosen.push(id);
  }
  if (chosen.length < 3) {
    const { data: pub } = await db.from("tests").select("module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
      .eq("status", "Published").is("parent_test_id", null).in("created_by", QA_ADMIN_IDS);
    const served = [...new Set((pub ?? []).flatMap((t) => [t.module_id, t.module_2_id, ...adaptiveIds(t)]).filter(Boolean))];
    const all = await sectionsOf(served);
    for (const id of served.sort((x, y) => (all.get(x)?.module_name ?? "").localeCompare(all.get(y)?.module_name ?? ""))) {
      if (chosen.length >= 3) break;
      if (!chosen.includes(id) && all.get(id)?.section === section && (await fullyApproved([id]))) chosen.push(id);
    }
  }
  if (chosen.length < 3) die(`only ${chosen.length} fully approved ${section} module(s) found in QA tests for an adaptive source`);
  return chosen;
}

const b = await chromium.launch();
const { page } = await login(b, C.admins[0].clerkId);
const api = page.request;
async function call(method, path, data) {
  const r = await api[method](BASE + path, data ? { data } : undefined);
  const j = await r.json().catch(() => ({}));
  return { status: r.status(), j };
}
async function publish(id, name) {
  const r = await call("post", `/api/admin/tests/${id}/publish`);
  if (r.status !== 200) die(`publish ${name} → HTTP ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
}

const out = {};
try {
  // ── sources ──────────────────────────────────────────────────
  async function source(key, name, section, reuse, preferred) {
    if (reuse && QA_ADMIN_IDS.includes(reuse.created_by) && reuse.is_adaptive && (reuse.test_kind ?? "section") === "section") {
      const secs = await sectionsOf(adaptiveIds(reuse));
      if (adaptiveIds(reuse).every((id) => secs.get(id)?.section === section) && (await fullyApproved(adaptiveIds(reuse)))) {
        log(`= ${key}: reuse ${reuse.test_name} (${reuse.id})`);
        return reuse.id;
      }
      log(`  ${reuse.test_name} is not a fully approved adaptive ${section} test; using "${name}"`);
    }
    const existing = await qaTestByName(name);
    if (existing) {
      if (!(await fullyApproved(adaptiveIds(existing)))) {
        die(`${name} (${existing.id}) has modules that are no longer fully approved — delete it (QA admin) and re-run to rebuild it from approved modules`);
      }
      log(`= ${key}: ${name} (${existing.id})`);
      return existing.id;
    }
    const [m1, easy, hard] = await pickModules(section, preferred);
    const r = await call("post", "/api/admin/tests", {
      testName: name, isAdaptive: true, module1Id: m1, module2EasyId: easy, module2HardId: hard,
      adaptiveThreshold: 60, timeLimitMinutes: section === RW ? 32 : 35, timeLimitMinutesModule2: section === RW ? 32 : 35,
      classGroupIds: [], studentIds: [], teacherIds: [],
    });
    if (r.status !== 201) die(`create ${name} → HTTP ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
    log(`+ ${key}: created ${name} (${r.j.data.id}), Draft and unassigned`);
    return r.j.data.id;
  }

  const base = async (k) => (TESTS[k] ? (await db.from("tests").select("*").eq("id", TESTS[k]).maybeSingle()).data : null);
  const eng = await base("engLinear");
  const untimed = await base("untimedEng");
  out.flRwSource = await source("flRwSource", RW_SOURCE_NAME, RW, null, [eng?.module_id, eng?.module_2_id, untimed?.module_id]);
  const adaptive = await base("adaptive");
  out.flMathSource = await source("flMathSource", MATH_SOURCE_NAME, "Math", adaptive, adaptive ? adaptiveIds(adaptive) : []);

  // ── full-length tests ────────────────────────────────────────
  for (const f of FULL_LENGTH) {
    let t = await qaTestByName(f.name);
    if (t && t.test_kind !== "full_length") die(`${f.name} (${t.id}) exists but is a ${t.test_kind} test`);
    if (!t) {
      const [rw1, rw2, m1, m2] = f.limits;
      const r = await call("post", "/api/admin/tests", {
        kind: "full_length", testName: f.name,
        rwSourceTestId: out.flRwSource, mathSourceTestId: out.flMathSource,
        rwTimeLimitMinutes: rw1, rwTimeLimitMinutesModule2: rw2, mathTimeLimitMinutes: m1, mathTimeLimitMinutesModule2: m2,
        breakMinutes: f.breakMinutes, allowSectionPause: f.allowSectionPause,
        showAnswersAfterSubmission: true, showExplanationsAfterSubmission: true, allowRetake: false,
        classGroupIds: CLASS_IDS, studentIds: [], teacherIds: [],
      });
      if (r.status !== 201) die(`create ${f.name} → HTTP ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
      t = (await db.from("tests").select("*").eq("id", r.j.data.id).single()).data;
      log(`+ ${f.key}: created ${f.name} (${t.id})`);
    } else {
      log(`= ${f.key}: ${f.name} (${t.id}) ${t.status}`);
      // The checks rely on these settings: a drifted fixture must be rebuilt, not used.
      const { data: ks } = await db.from("tests").select("section_order, time_limit_minutes, time_limit_minutes_module_2, created_by").eq("parent_test_id", t.id);
      const rwK = (ks ?? []).find((k) => k.section_order === 1);
      const mK = (ks ?? []).find((k) => k.section_order === 2);
      const drift = [];
      if (t.break_minutes !== f.breakMinutes) drift.push(`break ${t.break_minutes} (want ${f.breakMinutes})`);
      if (Boolean(t.allow_section_pause) !== f.allowSectionPause) drift.push(`pausing ${t.allow_section_pause}`);
      if (t.allow_retake) drift.push("allow_retake on");
      if (!t.show_answers_after_submission) drift.push("show answers off");
      const got = [rwK?.time_limit_minutes, rwK?.time_limit_minutes_module_2, mK?.time_limit_minutes, mK?.time_limit_minutes_module_2];
      if (got.join("/") !== f.limits.join("/")) drift.push(`limits ${got.join("/")} (want ${f.limits.join("/")})`);
      if ((ks ?? []).some((k) => k.created_by !== t.created_by)) drift.push("a section child has another creator");
      if (drift.length) die(`${f.name} (${t.id}) settings drifted: ${drift.join(", ")} — delete it (QA admin) and re-run`);
    }
    // A crashed FL-WINDOW-CLOSE may have left a past due date.
    if (t.due_date && Date.parse(t.due_date) < Date.now()) {
      await db.from("tests").update({ due_date: null }).eq("id", t.id);
      log(`  cleared a past due date on ${f.name}`);
    }
    if (t.status === "Draft") { await publish(t.id, f.name); log(`  published`); }
    else if (t.status === "Closed") {
      const r = await call("post", `/api/admin/tests/${t.id}/reopen`);
      if (r.status !== 200) die(`reopen ${f.name} → HTTP ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
      log(`  reopened`);
    }
    const { data: kids } = await db.from("tests").select("id, section_order, status").eq("parent_test_id", t.id);
    if ((kids ?? []).length !== 2) die(`${f.name} has ${(kids ?? []).length} section children (expected 2)`);
    out[f.key] = t.id;
  }
} catch (e) {
  if (!(e instanceof Die)) throw e;
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await b.close().catch(() => {});
}
if (process.exitCode) process.exit(process.exitCode);

const merged = { ...JSON.parse(readFileSync(TESTS_PATH, "utf-8")), ...out };
writeFileSync(TESTS_PATH, JSON.stringify(merged, null, 1));
log(`\nwrote ${Object.keys(out).join(", ")} → ${TESTS_PATH}`);
