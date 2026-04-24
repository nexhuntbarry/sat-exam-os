// Full-screen layout for test-taking — hides the sidebar/topbar
export default function TestTakeLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-screen overflow-hidden">{children}</div>;
}
