// .omc/qa/custom-test-nightly.mjs — DRAFT, not installed.
// Nightly Custom test checks on production with hidden QA accounts only
// (plan .omc/plans/custom-test.md §I). To install: copy to
// .omc/qa/harness/nightly/custom-checks.mjs and in nightly/run.mjs add
//
//   import { runCustomTestChecks } from "./custom-checks.mjs";
//   await runCustomTestChecks({
//     check, fail, skip, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN, correctPick, wrongPick,
//   });
//
// Post-deploy alone: ONLY=CT-CREATE,CT-FIXED,CT-ADAPTIVE,CT-BOTH-NOBREAK,CT-RESULT node nightly/run.mjs
//
// What it does (every test it makes is QA-owned, named "TEST qa-admin
// Custom <date> …", and deleted at the end — even after a crash):
//   CT-CREATE        QA admin: pool counts, preview (sizes, no repeats, Replace
//                    keeps skill + difficulty, Regenerate), Save as Draft for
//                    (a) Math fixed 8, (b) R&W adaptive 8 (threshold 60),
//                    (c) R&W + Math fixed 6 + 6 with the break OFF;
//                    stored shape (stage lists, stage modules hidden from the
//                    module list), publish readiness, assign + publish.
//   CT-FIXED         student 120: Math fixed — start, autosave, submit; graded
//                    on exactly the stage list (answer_records = list).
//   CT-ADAPTIVE      students 121 (all right → harder Module 2) and 122 (all
//                    wrong → easier Module 2); Module 2 = the right stage list.
//   CT-BOTH-NOBREAK  student 123: R&W M1 + M2, then /sat goes straight into
//                    Math (no break screen, Math Module 1 created at once),
//                    Math M1 + M2, combined result.
//   CT-RESULT        result pages 200, "Est." SAT label, no "in review, not
//                    scored" note; admin test page shows the rules card.
// Students 120–123 are borrowed onto the STUDENT1 login like the edge checks
// and the login is given back in `finally`.
import { chromium } from "playwright";
import { login, db, BASE, borrowLogin } from "../lib.mjs";

const STAGE_PREFIX = "c0570000-5ca6-4";
const isStage = (id) => typeof id === "string" && id.toLowerCase().startsWith(STAGE_PREFIX);
const parseStages = (qids) => {
  if (!Array.isArray(qids) || !isStage(qids[0])) return null;
  const out = new Map();
  let cur = null;
  for (const x of qids) {
    if (isStage(x)) out.set(x, (cur = []));
    else cur.push(x);
  }
  return out;
};
const DONE = (s) => s === "Submitted" || s === "Late";

export async function runCustomTestChecks(h) {
  const { check, fail, skip, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN, correctPick, wrongPick } = h;
  const AREA = "自訂測驗";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const made = {}; // kind → test id
  const QA_ADMIN = C.admins[0].id;

  async function asUser(clerkId, fn) {
    const b = await chromium.launch();
    try {
      const { page } = await login(b, clerkId);
      return await fn({ page, req: page.request });
    } finally {
      await b.close().catch(() => {});
    }
  }
  async function asStudent(n, fn) {
    const s = studentByN(n);
    if (!s) skip(`TEST Student ${n} missing from the cast`);
    const orig = C.students[0].id;
    await borrowLogin(s.id, STUDENT1_CLERK);
    try {
      return await asUser(STUDENT1_CLERK, (ctx) => fn({ ...ctx, student: s }));
    } finally {
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
    }
  }
  /** The owner rows (test or its two sections) of a Custom test. */
  async function owners(id) {
    const cols = "id, test_kind, section_order, is_adaptive, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, question_ids, adaptive_threshold";
    const { data: t } = await db.from("tests").select(cols).eq("id", id).single();
    if (t.test_kind !== "full_length") return [t];
    const { data: kids } = await db.from("tests").select(cols).eq("parent_test_id", id).order("section_order");
    return kids;
  }
  const stageQs = async (ids) => {
    const { data } = await db.from("questions").select("id, question_type, correct_answer").in("id", ids);
    const by = new Map((data ?? []).map((q) => [q.id, q]));
    return ids.map((id) => by.get(id)).filter(Boolean);
  };

  /** A request body for rules: counts from the official split the API returns. */
  function rulesFor(subject, parts, counts, brk = null) {
    const W = {
      rw: { "Information and Ideas": 26, "Craft and Structure": 28, "Expression of Ideas": 20, "Standard English Conventions": 26 },
      math: { Algebra: 35, "Advanced Math": 35, "Problem-Solving and Data Analysis": 15, "Geometry and Trigonometry": 15 },
    };
    const out = { v: 1, subject, order: subject === "both" ? ["rw", "math"] : [subject], break: brk, parts: {}, seed: "", family_id: "", version: 1 };
    for (const [k, p] of Object.entries(parts)) {
      // Spread n over the domains by weight, then one skill at a time over skills with questions.
      const skills = {};
      const doms = Object.keys(W[k]);
      let left = p.questions;
      const per = Object.fromEntries(doms.map((d) => [d, Math.floor((p.questions * W[k][d]) / 100)]));
      left -= Object.values(per).reduce((a, b) => a + b, 0);
      for (const d of doms.sort((a, b) => W[k][b] - W[k][a])) if (left-- > 0) per[d]++;
      for (const d of doms) {
        const avail = Object.entries(counts[k][d] ?? {})
          .filter(([s, c]) => !s.startsWith("Other") && c.Easy + c.Medium + c.Hard > 0)
          .sort((a, b) => b[1].Easy + b[1].Medium + b[1].Hard - (a[1].Easy + a[1].Medium + a[1].Hard));
        skills[d] = {};
        for (let i = 0; i < per[d]; i++) {
          const s = avail[i % Math.max(1, avail.length)][0];
          skills[d][s] = (skills[d][s] ?? 0) + 1;
        }
      }
      const n1 = Math.ceil(p.questions / 2);
      const two = p.adaptive || subject === "both";
      const sec = k === "rw" ? 71 : 95;
      out.parts[k] = {
        questions: p.questions,
        adaptive: p.adaptive,
        threshold: 60,
        skills,
        mix: {
          all: { Easy: 30, Medium: 40, Hard: 30 },
          m1: { Easy: 20, Medium: 60, Hard: 20 },
          m2_easy: { Easy: 50, Medium: 40, Hard: 10 },
          m2_hard: { Easy: 10, Medium: 40, Hard: 50 },
        },
        minutes: { m1: Math.ceil(((two ? n1 : p.questions) * sec) / 60), m2: two ? Math.ceil(((p.questions - n1) * sec) / 60) : null },
      };
    }
    return out;
  }

  try {
    // ═══════════════════════════════════════════════════════════════
    await check("CT-CREATE", [], "自訂測驗：管理員建立（題庫數量、預覽、替換、重新產生、存草稿、發佈）", AREA, async () => {
      const notes = [];
      await asUser(ADMIN_CLERK, async ({ req }) => {
        const pool = await req.get(`${BASE}/api/admin/custom-tests/pool`);
        if (pool.status() === 503) skip("migration 0035 not applied (Custom tests not enabled)");
        if (pool.status() !== 200) fail(`pool → HTTP ${pool.status()}`);
        const counts = (await pool.json()).data.counts;
        const configs = [
          ["mathFixed", rulesFor("math", { math: { questions: 8, adaptive: false } }, counts)],
          ["rwAdaptive", rulesFor("rw", { rw: { questions: 8, adaptive: true } }, counts)],
          ["bothNoBreak", rulesFor("both", { rw: { questions: 6, adaptive: false }, math: { questions: 6, adaptive: false } }, counts, null)],
        ];
        for (const [kind, rules] of configs) {
          const pv = await req.post(`${BASE}/api/admin/custom-tests/preview`, { data: { rules } });
          const pj = await pv.json().catch(() => ({}));
          if (pv.status() !== 200) fail(`${kind} preview → HTTP ${pv.status()} ${JSON.stringify(pj).slice(0, 200)}`);
          let { selection, seed, questions } = pj.data;
          const all = Object.values(selection.parts).flat().flatMap((s) => s.questionIds);
          if (new Set(all).size !== all.length) fail(`${kind}: a question appears twice in the preview`);
          if (all.some((id) => !questions[id])) fail(`${kind}: preview without a summary`);
          for (const [k, stages] of Object.entries(selection.parts)) {
            const n = rules.parts[k].questions;
            const want = rules.parts[k].adaptive ? [Math.ceil(n / 2), n - Math.ceil(n / 2), n - Math.ceil(n / 2)] : rules.subject === "both" ? [Math.ceil(n / 2), n - Math.ceil(n / 2)] : [n];
            const got = stages.map((s) => s.questionIds.length);
            if (JSON.stringify(got) !== JSON.stringify(want) && selection.shortfalls.length === 0) fail(`${kind} ${k}: module sizes ${got} ≠ ${want}`);
          }
          // Replace one: same skill + difficulty unless the note says otherwise.
          const [pk, stages] = Object.entries(selection.parts)[0];
          const target = stages[0].questionIds[0];
          const rp = await req.post(`${BASE}/api/admin/custom-tests/preview`, {
            data: { rules, seed: "rep" + stamp, replace: { selection, part: pk, questionId: target } },
          });
          const rj = await rp.json().catch(() => ({}));
          if (rp.status() !== 200) fail(`${kind} replace → HTTP ${rp.status()} ${JSON.stringify(rj).slice(0, 200)}`);
          const after = rj.data.selection.parts[pk][0].questionIds;
          const fresh = after.find((id) => !stages[0].questionIds.includes(id));
          if (!fresh || after.includes(target)) fail(`${kind}: Replace didn't swap the question`);
          const a = questions[target], b = rj.data.questions[fresh];
          if (!rj.data.note && (a.skill !== b.skill || a.difficulty !== b.difficulty)) fail(`${kind}: Replace changed ${a.skill}/${a.difficulty} → ${b.skill}/${b.difficulty} without a note`);
          selection = rj.data.selection;
          // Regenerate: a fresh draw is accepted too (not saved).
          const rg = await req.post(`${BASE}/api/admin/custom-tests/preview`, { data: { rules } });
          if (rg.status() !== 200) fail(`${kind} regenerate → HTTP ${rg.status()}`);
          // Save as Draft.
          const name = `TEST qa-admin Custom ${stamp} ${kind}`;
          const sv = await req.post(`${BASE}/api/admin/custom-tests`, { data: { name, rules, seed, selection, allowDuplicateName: true } });
          const sj = await sv.json().catch(() => ({}));
          if (sv.status() !== 201) fail(`${kind} save → HTTP ${sv.status()} ${JSON.stringify(sj).slice(0, 300)}`);
          made[kind] = sj.data.id;
          // Stored shape.
          const { data: t } = await db.from("tests").select("created_by, status, custom_rules, break_minutes, allow_section_pause").eq("id", made[kind]).single();
          if (t.created_by !== QA_ADMIN || t.status !== "Draft" || !t.custom_rules) fail(`${kind}: stored test is wrong (${JSON.stringify(t).slice(0, 160)})`);
          if (kind === "bothNoBreak" && (t.break_minutes !== 0 || t.allow_section_pause)) fail(`no-break test stored break ${t.break_minutes}/${t.allow_section_pause}`);
          for (const o of await owners(made[kind])) {
            const st = parseStages(o.question_ids);
            const served = [o.module_id, o.module_2_id, o.module_1_id, o.module_2_easy_id, o.module_2_hard_id].filter(Boolean);
            if (!st || served.some((m) => !st.has(m)) || st.size !== served.length) fail(`${kind}: stage lists don't match the served modules`);
            const { data: mods } = await db.from("modules").select("id, owner_test_id").in("id", served);
            if (mods.length !== served.length || mods.some((m) => m.owner_test_id !== o.id)) fail(`${kind}: stage modules not owned by ${o.id}`);
            const { count } = await db.from("questions").select("id", { count: "exact", head: true }).in("module_id", served);
            if (count) fail(`${kind}: a stage module owns ${count} questions`);
          }
          const ml = await req.get(`${BASE}/api/admin/modules`);
          const mj = await ml.json().catch(() => ({}));
          if ((mj.data ?? []).some((m) => isStage(m.id))) fail("stage modules show in the admin module list");
          // Assign the QA students, then publish (readiness runs on the referenced questions).
          const ids = [120, 121, 122, 123].map((n) => studentByN(n)?.id).filter(Boolean);
          const as = await req.patch(`${BASE}/api/admin/tests/${made[kind]}`, { data: { studentIds: ids } });
          if (as.status() !== 200) fail(`${kind} assign → HTTP ${as.status()}`);
          const pub = await req.post(`${BASE}/api/admin/tests/${made[kind]}/publish`);
          if (pub.status() !== 200) fail(`${kind} publish → HTTP ${pub.status()} ${(await pub.text()).slice(0, 200)}`);
          notes.push(`${kind} ok (${all.length} q${selection.shortfalls.length ? `, ${selection.shortfalls.length} shortfalls` : ""})`);
        }
      });
      return notes.join("; ");
    }, 6 * 60 * 1000);

    // ═══════════════════════════════════════════════════════════════
    await check("CT-FIXED", ["CT-CREATE"], "自訂測驗：單科固定題 — 開始、自動存檔、交卷，只批改所選題目", AREA, async () => {
      if (!made.mathFixed) skip("CT-CREATE didn't make the test");
      return asStudent(120, async ({ req, student }) => {
        const T = made.mathFixed;
        const st = await req.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
        const sj = await st.json().catch(() => ({}));
        if (st.status() > 201) fail(`start → HTTP ${st.status()} ${JSON.stringify(sj).slice(0, 160)}`);
        const subId = sj.data?.id ?? sj.id;
        const take = await req.get(`${BASE}/student/tests/${T}/take`);
        if (take.status() !== 200) fail(`take page → HTTP ${take.status()}`);
        const [o] = await owners(T);
        const list = parseStages(o.question_ids).get(o.module_id);
        const qs = await stageQs(list);
        const answers = Object.fromEntries(qs.map((q, i) => [q.id, i % 2 ? wrongPick(q) : correctPick(q)]));
        const p = await req.patch(`${BASE}/api/student/submissions/${subId}`, { data: { answers, metadata: {} } });
        if (p.status() >= 400) fail(`autosave → HTTP ${p.status()}`);
        const sub = await req.post(`${BASE}/api/student/submissions/${subId}/submit`, { data: { answers, metadata: {} } });
        if (sub.status() >= 400) fail(`submit → HTTP ${sub.status()} ${(await sub.text()).slice(0, 160)}`);
        const { data: row } = await db.from("submissions").select("status, total_questions, correct_count, module_id").eq("id", subId).single();
        if (!DONE(row.status) || row.total_questions !== list.length) fail(`graded ${row.total_questions} of ${list.length} (${row.status})`);
        const { data: ars } = await db.from("answer_records").select("question_id").eq("submission_id", subId);
        if (JSON.stringify(ars.map((a) => a.question_id).sort()) !== JSON.stringify([...list].sort())) fail("answer_records ≠ the stage list");
        return `${row.correct_count}/${row.total_questions}, student ${student.name}`;
      });
    }, 5 * 60 * 1000);

    // ═══════════════════════════════════════════════════════════════
    await check("CT-ADAPTIVE", ["CT-CREATE"], "自訂測驗：自適應 — 模組一全對進困難模組二、全錯進簡單模組二", AREA, async () => {
      if (!made.rwAdaptive) skip("CT-CREATE didn't make the test");
      const T = made.rwAdaptive;
      const [o] = await owners(T);
      const st = parseStages(o.question_ids);
      const notes = [];
      for (const [n, right, want] of [[121, true, o.module_2_hard_id], [122, false, o.module_2_easy_id]]) {
        notes.push(
          await asStudent(n, async ({ req }) => {
            const s = await req.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
            const sj = await s.json().catch(() => ({}));
            if (s.status() > 201) fail(`start → HTTP ${s.status()}`);
            const m1 = sj.data?.id ?? sj.id;
            const qs = await stageQs(st.get(o.module_1_id));
            const answers = Object.fromEntries(qs.map((q) => [q.id, right ? correctPick(q) : wrongPick(q)]));
            const sub = await req.post(`${BASE}/api/student/submissions/${m1}/submit`, { data: { answers, metadata: {} } });
            const subJ = await sub.json().catch(() => ({}));
            if (sub.status() >= 400 || !subJ.data?.nextSubmissionId) fail(`M1 submit → HTTP ${sub.status()} ${JSON.stringify(subJ).slice(0, 160)}`);
            const { data: m2 } = await db.from("submissions").select("module_id, adaptive_track").eq("id", subJ.data.nextSubmissionId).single();
            if (m2.module_id !== want) fail(`routed to ${m2.adaptive_track} (${right ? "all right" : "all wrong"})`);
            const qs2 = await stageQs(st.get(want));
            const a2 = Object.fromEntries(qs2.map((q) => [q.id, correctPick(q)]));
            await req.get(`${BASE}/student/tests/${T}/take?start=1`);
            const s2 = await req.post(`${BASE}/api/student/submissions/${subJ.data.nextSubmissionId}/submit`, { data: { answers: a2, metadata: {} } });
            if (s2.status() >= 400) fail(`M2 submit → HTTP ${s2.status()}`);
            const { data: r2 } = await db.from("submissions").select("total_questions").eq("id", subJ.data.nextSubmissionId).single();
            if (r2.total_questions !== st.get(want).length) fail(`M2 graded ${r2.total_questions} of ${st.get(want).length}`);
            return `${n}: ${m2.adaptive_track}`;
          }),
        );
      }
      return notes.join("; ");
    }, 8 * 60 * 1000);

    // ═══════════════════════════════════════════════════════════════
    await check("CT-BOTH-NOBREAK", ["CT-CREATE"], "自訂測驗：R&W + 數學、無休息 — 閱讀交卷後直接進入數學", AREA, async () => {
      if (!made.bothNoBreak) skip("CT-CREATE didn't make the test");
      const T = made.bothNoBreak;
      const [rw, math] = await owners(T);
      return asStudent(123, async ({ req, page }) => {
        const start = await req.post(`${BASE}/api/student/full-length/${T}/start`, { data: {} });
        if (start.status() >= 400) fail(`full-length start → HTTP ${start.status()} ${(await start.text()).slice(0, 160)}`);
        const submitSection = async (o) => {
          const st = parseStages(o.question_ids);
          for (const [mod, label] of [[o.module_id, "M1"], [o.module_2_id, "M2"]]) {
            const { data: row } = await db.from("submissions").select("id").eq("test_id", o.id).eq("module_id", mod).eq("status", "In Progress").maybeSingle();
            if (!row) fail(`${o.section_order === 1 ? "R&W" : "Math"} ${label} row missing`);
            await page.goto(`${BASE}/student/tests/${T}/sat?start=1`, { waitUntil: "domcontentloaded" });
            const qs = await stageQs(st.get(mod));
            const answers = Object.fromEntries(qs.map((q) => [q.id, correctPick(q)]));
            const r = await req.post(`${BASE}/api/student/submissions/${row.id}/submit`, { data: { answers, metadata: {} } });
            if (r.status() >= 400) fail(`${label} submit → HTTP ${r.status()} ${(await r.text()).slice(0, 160)}`);
          }
        };
        await submitSection(rw);
        // R&W done: the runner must go straight into Math — no break screen.
        await page.goto(`${BASE}/student/tests/${T}/sat`, { waitUntil: "domcontentloaded" });
        const html = await page.content();
        if (/take a break|Break time left|Resume testing/i.test(html)) fail("break screen shown with the break off");
        const { data: mathM1 } = await db.from("submissions").select("id, status").eq("test_id", math.id).eq("module_id", math.module_id).maybeSingle();
        if (!mathM1) fail("Math Module 1 wasn't started right after R&W");
        await submitSection(math);
        const res = await req.get(`${BASE}/student/tests/${T}/result`);
        if (res.status() !== 200) fail(`result → HTTP ${res.status()}`);
        const { data: att } = await db.from("full_length_attempts").select("break_minutes").eq("test_id", T).limit(1).single();
        if (att.break_minutes !== 0) fail(`attempt break snapshot ${att.break_minutes}`);
        return "R&W → Math with no break; result 200";
      });
    }, 10 * 60 * 1000);

    // ═══════════════════════════════════════════════════════════════
    await check("CT-RESULT", ["CT-FIXED", "CT-ADAPTIVE"], "自訂測驗：成績頁 — 預估分數標示、無「審核中未計分」提示、規則卡", AREA, async () => {
      if (!made.rwAdaptive) skip("no test");
      const notes = [];
      await asUser(ADMIN_CLERK, async ({ req }) => {
        const r = await req.get(`${BASE}/admin/tests/${made.rwAdaptive}`);
        const html = await r.text();
        if (r.status() !== 200) fail(`admin test page → HTTP ${r.status()}`);
        if (!/Custom test rules/.test(html) || !/Make another version/.test(html)) fail("rules card missing");
        if (/in review, not scored/.test(html)) fail("bogus 'in review, not scored' note on a Custom test");
        if (!/Est\./.test(html)) notes.push("no 'Est.' label seen (8-question part: SAT hidden under 10 — expected)");
        const pool = await req.get(`${BASE}/api/admin/custom-tests/pool?familyId=${encodeURIComponent((await db.from("tests").select("custom_rules").eq("id", made.rwAdaptive).single()).data.custom_rules.family_id)}`);
        const pj = await pool.json();
        if (!(pj.data.excluded > 0)) fail("Make another version doesn't exclude this version's questions");
      });
      return notes.join("; ") || "ok";
    }, 4 * 60 * 1000);
  } finally {
    // Clean up everything this run made (QA-owned only).
    for (const id of Object.values(made)) {
      const { data: t } = await db.from("tests").select("created_by, test_name").eq("id", id).maybeSingle();
      if (t && t.created_by === QA_ADMIN && t.test_name.startsWith("TEST qa-admin Custom ")) {
        const kids = (await db.from("tests").select("id").eq("parent_test_id", id)).data?.map((k) => k.id) ?? [];
        const subs = (await db.from("submissions").select("id").in("test_id", [id, ...kids])).data?.map((s) => s.id) ?? [];
        if (subs.length) await db.from("answer_records").delete().in("submission_id", subs);
        await db.from("tests").delete().eq("id", id); // children, stage modules, submissions, attempts cascade
      }
    }
  }
}
