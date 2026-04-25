import ComingSoon from "@/components/shared/ComingSoon";

export default function TeacherResultsPage() {
  return (
    <ComingSoon
      title="Student Results"
      description="A consolidated view of all your students' results across every test will be available here. For now, view results per test from My Tests."
      dashboardHref="/teacher/tests"
      dashboardLabel="Go to My Tests"
    />
  );
}
