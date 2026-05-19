import { escapeHtml } from "../escape";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://sat.nexhunt.xyz";

export function welcomeStudentEmail(displayName: string): {
  subject: string;
  html: string;
} {
  const safeName = escapeHtml(displayName);
  return {
    subject: "Welcome to SAT Exam OS — Account Pending Approval",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to SAT Exam OS</title>
</head>
<body style="margin:0;padding:0;background-color:#0A1330;font-family:'Plus Jakarta Sans',ui-sans-serif,system-ui,sans-serif;color:#E6E9EE;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:560px;background-color:#0F1A3A;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:40px;">
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <div style="font-size:28px;font-weight:800;background:linear-gradient(135deg,#2563EB,#84CC16);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">
                SAT Exam OS
              </div>
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="color:#FFFFFF;font-size:22px;font-weight:700;margin:0 0 16px;">
                Welcome, ${safeName}!
              </h1>
              <p style="color:#CBD5E1;font-size:15px;line-height:1.7;margin:0 0 24px;">
                Thank you for registering for SAT Exam OS. Your account has been received and is
                currently <strong style="color:#F59E0B;">pending admin approval</strong>.
              </p>
              <p style="color:#CBD5E1;font-size:15px;line-height:1.7;margin:0 0 32px;">
                You'll receive another email once your account is approved and you're ready to
                start your SAT preparation journey.
              </p>
              <div style="background:rgba(37,99,235,0.1);border:1px solid rgba(240,82,61,0.18);border-radius:12px;padding:20px;margin-bottom:32px;">
                <p style="color:#93C5FD;font-size:14px;margin:0;line-height:1.6;">
                  While waiting, you can log in to check your account status at any time.
                </p>
              </div>
              <table width="100%">
                <tr>
                  <td align="center">
                    <a href="${BASE_URL}/student"
                       style="display:inline-block;padding:14px 32px;background-color:#2563EB;color:#FFFFFF;font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;">
                      Check Account Status
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:40px;border-top:1px solid rgba(255,255,255,0.07);margin-top:40px;">
              <p style="color:#64748B;font-size:12px;margin:0;text-align:center;line-height:1.6;">
                SAT Exam OS &mdash; AI-powered SAT test management<br/>
                SAT is a registered trademark of College Board. This platform is not affiliated with College Board.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
