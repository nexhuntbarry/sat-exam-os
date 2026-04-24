import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { getServiceClient } from "@/lib/supabase";
import { sendEmail } from "@/lib/email/send";
import { welcomeStudentEmail } from "@/lib/email/templates/welcome-student";

const ADMIN_EMAILS = new Set([
  "barry.py.chuang01@gmail.com",
  "nexhunt.barry@gmail.com",
  "happymaryann.barry@gmail.com",
]);

interface ClerkEmailAddress {
  email_address: string;
  id: string;
}

interface ClerkUserCreatedEvent {
  type: "user.created";
  data: {
    id: string;
    email_addresses: ClerkEmailAddress[];
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    created_at: number;
  };
}

interface ClerkUserUpdatedEvent {
  type: "user.updated";
  data: {
    id: string;
    email_addresses: ClerkEmailAddress[];
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    updated_at: number;
  };
}

type ClerkWebhookEvent = ClerkUserCreatedEvent | ClerkUserUpdatedEvent;

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook/clerk] CLERK_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const headersList = await headers();
  const svixId = headersList.get("svix-id");
  const svixTimestamp = headersList.get("svix-timestamp");
  const svixSignature = headersList.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const body = await req.text();

  const wh = new Webhook(secret);
  let event: ClerkWebhookEvent;
  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = getServiceClient();

  if (event.type === "user.created") {
    const { id: clerkUserId, email_addresses, first_name, last_name, username } = event.data;
    const email = email_addresses[0]?.email_address ?? "";
    const displayName =
      [first_name, last_name].filter(Boolean).join(" ") || username || email.split("@")[0];

    const isAdmin = ADMIN_EMAILS.has(email);
    const role = isAdmin ? "admin" : "student";
    const accountStatus = isAdmin ? "approved" : "pending";

    const { error } = await supabase.from("users").upsert(
      {
        clerk_user_id: clerkUserId,
        email,
        display_name: displayName,
        role,
        account_status: accountStatus,
        metadata: {},
      },
      { onConflict: "clerk_user_id" }
    );

    if (error) {
      console.error("[webhook/clerk] Failed to upsert user:", error);
      return NextResponse.json({ error: "DB error" }, { status: 500 });
    }

    // Send welcome email (non-blocking, only for students)
    if (!isAdmin) {
      const { subject, html } = welcomeStudentEmail(displayName);
      sendEmail({ to: email, subject, html }).catch(() => {});
    }
  }

  if (event.type === "user.updated") {
    const { id: clerkUserId, email_addresses, first_name, last_name, username } = event.data;
    const email = email_addresses[0]?.email_address ?? "";
    const displayName =
      [first_name, last_name].filter(Boolean).join(" ") || username || email.split("@")[0];

    const { error } = await supabase
      .from("users")
      .update({ email, display_name: displayName, updated_at: new Date().toISOString() })
      .eq("clerk_user_id", clerkUserId);

    if (error) {
      console.error("[webhook/clerk] Failed to update user:", error);
      return NextResponse.json({ error: "DB error" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
