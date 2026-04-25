import ComingSoon from "@/components/shared/ComingSoon";

export default function TeacherAnalysisPage() {
  return (
    <ComingSoon
      title="Question Analysis"
      description="Cross-test question analysis — identify the most frequently missed topics across all your tests and students. Access per-test analytics from My Tests."
      dashboardHref="/teacher/tests"
      dashboardLabel="Go to My Tests"
    />
  );
}
