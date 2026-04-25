import ComingSoon from "@/components/shared/ComingSoon";

export default function AdminSettingsPage() {
  return (
    <ComingSoon
      title="Settings"
      description="Platform configuration — branding, notification preferences, AI parsing defaults, and account management options will be available here."
      dashboardHref="/admin"
      dashboardLabel="Back to Admin Dashboard"
    />
  );
}
