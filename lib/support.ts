import { getServiceClient } from "@/lib/supabase";
import { createNotification } from "@/lib/notifications";

import {
  SUPPORT_TYPE,
  SUPPORT_REPLY_TYPE,
  type SupportMessage,
  type SupportQuestionRef,
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

export interface NewSupportRequest {
  userId: string;
  reporterName: string;
  reporterEmail: string;
  body: string;
  screenshots?: string[];
  status?: SupportStatus;
  question?: SupportQuestionRef;
  source?: SupportRequest["source"];
  /** Backfill: the original report time (thread + first message). */
  at?: string;
  /** Backfill: a dev message closing the thread with the original report's state. */
  devMessage?: { body: string; at: string };
}

/**
 * Open a "Report a Problem" thread (one notifications row, see support-shared).
 * read_at is set so the request row itself never counts as an unread bell item.
 */
export async function createSupportRequest(db: DbClient, input: NewSupportRequest): Promise<string> {
  const at = input.at ?? new Date().toISOString();
  const messages: SupportMessage[] = [{ from: "reporter", body: input.body, at, screenshots: input.screenshots ?? [] }];
  if (input.devMessage) messages.push({ from: "dev", body: input.devMessage.body, at: input.devMessage.at });
  const payload: SupportRequest = {
    kind: SUPPORT_TYPE,
    status: input.status ?? "new",
    reporter_name: input.reporterName,
    reporter_email: input.reporterEmail,
    messages,
    updated_at: messages[messages.length - 1].at,
    ...(input.question ? { question: input.question } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
  const { data, error } = await db
    .from("notifications")
    .insert({ user_id: input.userId, type: SUPPORT_TYPE, payload, read_at: at, created_at: at })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/** The thread opened for a bug_reports row ("Report to dev"), if any. */
export async function findSupportForBugReport(db: DbClient, bugReportId: string): Promise<SupportRow | null> {
  const { data } = await db
    .from("notifications")
    .select("id, user_id, created_at, payload")
    .eq("type", SUPPORT_TYPE)
    .eq("payload->source->>id", bugReportId)
    .limit(1)
    .maybeSingle();
  return (data as SupportRow | null) ?? null;
}

/** First message of a thread opened from "Report to dev". */
export function bugReportSupportBody(note: string | null | undefined): string {
  return `Reported from the question review page ("Report to dev").\n\n${note?.trim() || "(no note)"}`;
}

/**
 * A bug report was resolved (auto-fix or the bug-reports page): post the
 * result on its support thread as a dev reply, status fixed. Returns false
 * when the report has no thread (caller falls back to the old bell item).
 */
export async function resolveBugReportThread(db: DbClient, bugReportId: string, message: string): Promise<boolean> {
  const row = await findSupportForBugReport(db, bugReportId);
  if (!row) return false;
  await addSupportMessage(db, row, { from: "dev", body: message }, "fixed");
  return true;
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
