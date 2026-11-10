// One-off: copy users from the Clerk development instance to the production
// instance, and (with --apply-db) point users.clerk_user_id at the new ids.
//
//   npx tsx --env-file=.env.prod scripts/clerk-migrate.ts            # import into Clerk prod (idempotent)
//   npx tsx --env-file=.env.prod scripts/clerk-migrate.ts --apply-db # also rewrite users.clerk_user_id (cutover only)
//
// Reads the live secret from .env.clerk-live (CLERK_SECRET_KEY=sk_live_…).
// Passwords can't be exported from Clerk, so password users are created
// without one; they sign in with Google / an email code or reset it.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const DEV = process.env.CLERK_SECRET_KEY!;
const LIVE = readFileSync(".env.clerk-live", "utf-8").match(/^CLERK_SECRET_KEY=(\S+)/m)![1];
if (!DEV.startsWith("sk_test_") || !LIVE.startsWith("sk_live_")) throw new Error("key mismatch");
const APPLY_DB = process.argv.includes("--apply-db");
const REVERT_DB = process.argv.includes("--revert-db");
const MAP_FILE = ".omc/clerk-migration-map.json";

async function clerk(key: string, path: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.clerk.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} ${res.status}: ${JSON.stringify(body)}`);
    return body;
  }
}

async function listAll(key: string): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; ; off += 100) {
    const page = await clerk(key, `/users?limit=100&offset=${off}&order_by=created_at`);
    out.push(...page);
    if (page.length < 100) return out;
  }
}

const primaryEmail = (u: any) =>
  (u.email_addresses.find((e: any) => e.id === u.primary_email_address_id) ?? u.email_addresses[0])?.email_address?.toLowerCase();

async function revert() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const map = JSON.parse(readFileSync(MAP_FILE, "utf-8")) as Record<string, { live: string; dbId: string | null }>;
  let n = 0;
  for (const [devId, m] of Object.entries(map)) {
    if (!m.dbId) continue;
    const { error: e } = await db.from("users").update({ clerk_user_id: devId }).eq("id", m.dbId).eq("clerk_user_id", m.live);
    if (!e) n++;
  }
  console.log(`db rows reverted to dev ids: ${n}`);
}

async function main() {
  if (REVERT_DB) return revert();
  const db =createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: rows, error } = await db.from("users").select("id, email, clerk_user_id");
  if (error) throw error;
  const rowByClerk = new Map(rows!.filter((r) => r.clerk_user_id).map((r) => [r.clerk_user_id as string, r]));

  const devUsers = await listAll(DEV);
  const liveByEmail = new Map((await listAll(LIVE)).map((u) => [primaryEmail(u), u]));
  const map: Record<string, { email: string; live: string; dbId: string | null }> = {};
  let created = 0, existed = 0;

  for (const u of devUsers) {
    const email = primaryEmail(u);
    if (!email) { console.warn("skip (no email)", u.id); continue; }
    const row = rowByClerk.get(u.id) ?? null;
    let live = liveByEmail.get(email);
    if (live) existed++;
    else {
      live = await clerk(LIVE, "/users", {
        method: "POST",
        body: JSON.stringify({
          email_address: [email],
          first_name: u.first_name ?? undefined,
          last_name: u.last_name ?? undefined,
          external_id: row?.id ?? undefined,
          skip_password_requirement: true,
          skip_password_checks: true,
          created_at: new Date(u.created_at).toISOString(),
        }),
      });
      created++;
    }
    map[u.id] = { email, live: live.id, dbId: row?.id ?? null };
  }
  writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  console.log(`dev users ${devUsers.length}; created ${created}; already in prod ${existed}; map -> ${MAP_FILE}`);

  if (!APPLY_DB) return;
  let updated = 0;
  for (const [devId, m] of Object.entries(map)) {
    if (!m.dbId) continue;
    const { error: e } = await db.from("users").update({ clerk_user_id: m.live }).eq("id", m.dbId).eq("clerk_user_id", devId);
    if (e) console.error("db update failed", m.email, e.message); else updated++;
  }
  console.log(`db rows repointed: ${updated}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
