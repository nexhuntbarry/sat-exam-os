import ComingSoon from "@/components/shared/ComingSoon";
import PageIntro from "@/components/shared/PageIntro";

export default function AdminReportsPage() {
  return (
    <>
      <PageIntro tKey="admin.reports" />
      <ComingSoon
        title="Reports"
        description="Platform-wide reporting and analytics will be available here — test completion rates, student performance trends, and module effectiveness."
        dashboardHref="/admin"
        dashboardLabel="Back to Admin Dashboard"
      />
    </>
  );
}
