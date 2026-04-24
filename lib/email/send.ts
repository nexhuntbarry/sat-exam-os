import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = "SAT Exam OS <noreply@sat.nexhunt.xyz>";

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
    console.error("[email] Failed to send email:", err);
  }
}
