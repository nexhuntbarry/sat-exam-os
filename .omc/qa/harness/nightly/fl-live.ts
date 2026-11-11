// Reads {"ids": [...question ids]} JSON on stdin, prints the ids the app's
// own live-question guard (lib/live-questions liveQuestionIds) counts as
// live. Read-only. Run with tsx from the app root (FL-LIVE-GUARD).
import { createClient } from "@supabase/supabase-js";
import { liveQuestionIds } from "../../../../lib/live-questions";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  const { ids } = JSON.parse(raw || "{}") as { ids?: string[] };
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "x", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const live = await liveQuestionIds(db, ids ?? []);
  process.stdout.write(JSON.stringify([...live]));
});
