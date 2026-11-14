"use client";

// Test status on the teacher test page: the Admin → Tests status menu
// (TestStatusActions, via /api/teacher/tests/[id]/*) when the teacher
// manages the test (lib/test-manage), a plain badge otherwise.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge, type TestStatus } from "@/components/ui/StatusBadge";
import { TestStatusMenu } from "@/app/(admin)/admin/tests/TestStatusActions";

export default function TeacherTestStatus({
  testId,
  testName,
  status: serverStatus,
  manages,
}: {
  testId: string;
  testName: string;
  status: TestStatus;
  manages: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(serverStatus);
  useEffect(() => setStatus(serverStatus), [serverStatus]);

  if (!manages) return <StatusBadge kind="test" status={status} />;
  return (
    <TestStatusMenu
      testId={testId}
      testName={testName}
      status={status}
      onChanged={(_id, next) => {
        setStatus(next);
        router.refresh();
      }}
      apiBase="/api/teacher/tests"
      linkIssues={false}
    />
  );
}
