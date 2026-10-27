import { getServiceClient } from "@/lib/supabase";
import { createNotification } from "@/lib/notifications";

import {
  SUPPORT_TYPE,
  SUPPORT_REPLY_TYPE,
  type SupportMessage,
  type SupportRequest,
  type SupportRow,
  type SupportStatus,
} from "@/lib/support-shared";

export * from "@/lib/support-shared";

type DbClient = ReturnType<typeof getServiceClient>;

export async function listSupportRequests(db: DbClient, userId: string): Promise<SupportRow[]> {
  const { data, error } = await db
    .from("notifications")
    .select("id, user_id, created_at, payload")
    .eq("type", SUPPORT_TYPE)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as SupportRow[];
}

export async function getSupportRequest(db: DbClient, id: string): Promise<SupportRow | null> {
  const { data } = await db
    .from("notifications")
    .select("id, user_id, created_at, payload")
    .eq("type", SUPPORT_TYPE)
    .eq("id", id)
    .maybeSingle();
  return (data as SupportRow | null) ?? null;
}

/** Append a message (and optionally change status); pings the reporter's bell on a dev reply. */
export async function addSupportMessage(
  db: DbClient,
  row: SupportRow,
  msg: Omit<SupportMessage, "at">,
  status?: SupportStatus,
): Promise<SupportRequest> {
  const now = new Date().toISOString();
  const payload: SupportRequest = {
    ...row.payload,
    status: status ?? row.payload.status,
    messages: [...row.payload.messages, { ...msg, at: now }],
    updated_at: now,
  };
  const { error } = await db.from("notifications").update({ payload }).eq("id", row.id);
  if (error) throw new Error(error.message);
  if (msg.from === "dev") {
    await createNotification(db, row.user_id, SUPPORT_REPLY_TYPE, {
      kind: SUPPORT_REPLY_TYPE,
      request_id: row.id,
      status: payload.status,
      message: msg.body,
    });
  }
  return payload;
}
