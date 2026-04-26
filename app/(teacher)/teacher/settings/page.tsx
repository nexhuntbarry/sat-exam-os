import ComingSoon from "@/components/shared/ComingSoon";
import PageIntro from "@/components/shared/PageIntro";

export default function TeacherSettingsPage() {
  return (
    <>
      <PageIntro tKey="teacher.settings" />
      <ComingSoon
        title="Settings"
        description="Profile preferences, notification settings, and teaching preferences will be configurable here."
        dashboardHref="/teacher"
        dashboardLabel="Back to Dashboard"
      />
    </>
  );
}
