// scripts/backfill-live-fix-snapshots.ts
//
// The Review Queue's "Fixed in a live test" group shows before / after and
// offers Undo (lib/live-fix.ts). New live fixes record the earlier version
// themselves; for the older ones this script finds it in the local row backups
// the fix scripts wrote before writing (.omc/backups/*.json).
//
// Rules (review 2026-11-09):
//   - only real pre-write backups: files written since --since (default
//     2026-11-01, live fixes started 11-02), not dry-run / candidate lists, and
//     only objects that are full question rows (they carry updated_at or
//     parsing_status next to the content);
//   - the version before the FIRST change: the OLDEST such copy whose content
//     differs from the row now (lib/live-fix.ts keeps the first unconfirmed
//     version too);
//   - bound to the row's current leading [live-fix] text (snapshot.tag), so
//     it stops counting once that change is confirmed or replaced.
// Stored snapshots are re-checked against these rules: a different version
// is replaced, one with no valid copy any more is removed.
// Writes only app_settings "live_fix_before:<id>"; questions are not touched.
// Dry run by default; idempotent.
//
//   npx tsx --env-file=.env.prod scripts/backfill-live-fix-snapshots.ts           # dry run
//   npx tsx --env-file=.env.prod scripts/backfill-live-fix-snapshots.ts --apply [--since 2026-11-01]
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { LIVE_FIX_TAG } from "../lib/live-questions";
import { fetchAllRows } from "../lib/fetch-all-rows";
import { changedFields, liveFixHead, loadLiveFixSnapshots, LIVE_FIX_SNAPSHOT_PREFIX, pickSnapshotFields, type LiveFixSnapshot } from "../lib/live-fix";

const APPLY = process.argv.includes("--apply");
const SINCE = Date.parse(process.argv[process.argv.indexOf("--since") + 1] ?? "") || Date.parse("2026-11-01T00:00:00Z");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Not a pre-write row backup. */
const NOT_A_BACKUP = /dry[-_]?run|candidates|report|preview/i;

/** Full question rows inside a backup file (arrays, nested maps). */
function rowsIn(x: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(x)) for (const v of x) rowsIn(v, out);
  else if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const content = "question_text" in o || "correct_answer" in o || "explanation" in o;
    if (typeof o.id === "string" && content && ("updated_at" in o || "parsing_status" in o)) out.push(o);
    else for (const v of Object.values(o)) rowsIn(v, out);
  }
  return out;
}

/** Field-by-field (JSONB doesn't keep key order). */
const sameFields = (a: LiveFixSnapshot | undefined, b: LiveFixSnapshot) =>
  !!a && changedFields(a, b.fields as Record<string, unknown>).length === 0 && changedFields(b, a.fields as Record<string, unknown>).length === 0;
const same = (a: LiveFixSnapshot | undefined, b: LiveFixSnapshot) => sameFields(a, b) && a?.tag === b.tag;

async function main() {
  const { data: live, error } = await fetchAllRows<Record<string, unknown>>((from, to) =>
    db
      .from("questions")
      .select("id, module_id, original_question_number, question_text, choices, correct_answer, explanation, image_urls, image_alts, has_image, question_type, parsing_notes")
      .ilike("parsing_notes", `${LIVE_FIX_TAG}%`)
      .order("id")
      .range(from, to),
  );
  if (error) throw new Error(`live-fix questions: ${JSON.stringify(error)}`);
  const rows = (live ?? []) as Record<string, unknown>[];
  const stored = await loadLiveFixSnapshots(db, rows.map((r) => r.id as string));
  const dir = path.join(process.cwd(), ".omc", "backups");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !NOT_A_BACKUP.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((x) => x.mtime >= SINCE)
    .sort((a, b) => a.mtime - b.mtime); // oldest first
  const ids = new Set(rows.map((r) => r.id as string));
  const copies = new Map<string, { file: string; mtime: number; row: Record<string, unknown> }[]>();
  for (const { f, mtime } of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    if (![...ids].some((id) => text.includes(id))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const r of rowsIn(parsed)) if (ids.has(r.id as string)) copies.set(r.id as string, [...(copies.get(r.id as string) ?? []), { file: f, mtime, row: r }]);
  }

  const writes: { key: string; value: LiveFixSnapshot }[] = [];
  const deletes: string[] = [];
  const tally = { unchanged: 0, new: 0, replaced: 0, removed: 0, none: 0 };
  for (const r of rows) {
    const id = r.id as string;
    const label = `Q${r.original_question_number} ${id.slice(0, 8)}`;
    // Oldest copy that differs from now = the version before the first change.
    const hit = (copies.get(id) ?? []).find((c) => changedFields({ at: "", source: "", fields: pickSnapshotFields(c.row) }, r).length > 0);
    const old = stored.get(id);
    if (!hit) {
      if (old) {
        deletes.push(id);
        tally.removed++;
        console.log(`  remove ${label}: no valid pre-write copy (was from ${old.source})`);
      } else tally.none++;
      continue;
    }
    const value: LiveFixSnapshot = {
      at: new Date(hit.mtime).toISOString(),
      source: `backup ${hit.file}`,
      fields: pickSnapshotFields(hit.row),
      tag: liveFixHead(r.parsing_notes as string | null) ?? undefined,
    };
    if (old && same(old, value)) {
      tally.unchanged++;
      continue;
    }
    tally[!old ? "new" : "replaced"]++;
    const what = !old ? "new" : sameFields(old, value) ? "same version, now bound to its [live-fix] text" : `DIFFERENT version: ${old.source} → ${value.source}`;
    console.log(`  ${label}: ${changedFields(value, r).join(", ")} — ${what}`);
    writes.push({ key: `${LIVE_FIX_SNAPSHOT_PREFIX}${id}`, value });
  }
  console.log(
    `\n${APPLY ? "APPLY" : "DRY RUN"}: ${rows.length} live-fix questions · ${tally.new} new · ${tally.replaced} replaced/re-bound · ${tally.removed} removed · ${tally.unchanged} unchanged · ${tally.none} with no earlier version`,
  );
  if (!APPLY) return;
  let ok = 0;
  for (const w of writes) {
    const { error: e } = await db.from("app_settings").upsert({ key: w.key, value: w.value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (!e) ok++;
    else console.error(w.key, e.message);
  }
  for (const id of deletes) {
    const { error: e } = await db.from("app_settings").delete().eq("key", `${LIVE_FIX_SNAPSHOT_PREFIX}${id}`);
    if (e) console.error(id, e.message);
  }
  console.log(`stored: ${ok}/${writes.length} · removed: ${deletes.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
