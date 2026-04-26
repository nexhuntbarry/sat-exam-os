import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Use Resend's free verified domain until sat.nexhunt.xyz DNS (SPF/DKIM) is verified
// To use custom domain: verify in Resend dashboard then change FROM to "SAT Exam OS <noreply@sat.nexhunt.xyz>"
const FROM = process.env.RESEND_FROM ?? "SAT Exam OS <onboarding@resend.dev>";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  if (!resend) {
    console.log("[email:dev] Would send email:", {
      to: opts.to,
      subject: opts.subject,
    });
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
    });
  } catch (err) {
    // Re-throw so callers can decide how to surface the failure (toast,
    // status response, retry queue, etc.). Library should not swallow.
    console.error("[email] Failed to send email:", err);
    throw err;
  }
}
