import ComingSoon from "@/components/shared/ComingSoon";
import PageIntro from "@/components/shared/PageIntro";

export default function AdminSettingsPage() {
  return (
    <>
      <PageIntro tKey="admin.settings" />
      <ComingSoon
        title="Settings"
        description="Platform configuration — branding, notification preferences, AI parsing defaults, and account management options will be available here."
        dashboardHref="/admin"
        dashboardLabel="Back to Admin Dashboard"
      />
    </>
  );
}
