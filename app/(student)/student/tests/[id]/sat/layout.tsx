// Full-screen layout for the full-length SAT (same as the take page).
export default function FullLengthSatLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-screen overflow-hidden">{children}</div>;
}
