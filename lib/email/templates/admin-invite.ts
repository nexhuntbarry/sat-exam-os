export function adminInviteEmail(
  inviteUrl: string,
  inviterName?: string,
): { subject: string; html: string } {
  const fromText = inviterName ? ` from ${inviterName}` : "";
  return {
    subject: "You're invited as an admin on SAT Exam OS",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin Invitation — SAT Exam OS</title>
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
                You&rsquo;re invited as an admin
              </h1>
              <p style="color:#CBD5E1;font-size:15px;line-height:1.7;margin:0 0 24px;">
                You&rsquo;ve received an admin invitation${fromText} for SAT Exam OS.
                As an admin you can manage modules, tests, teachers, students, and analytics.
              </p>
              <p style="color:#CBD5E1;font-size:15px;line-height:1.7;margin:0 0 32px;">
                Click below to accept the invitation and set up your account.
                This link expires in 7 days.
              </p>
              <table width="100%">
                <tr>
                  <td align="center">
                    <a href="${inviteUrl}"
                       style="display:inline-block;padding:14px 32px;background-color:#84CC16;color:#0A1330;font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color:#64748B;font-size:13px;margin:24px 0 0;text-align:center;">
                Or copy this link: <a href="${inviteUrl}" style="color:#84CC16;">${inviteUrl}</a>
              </p>
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
