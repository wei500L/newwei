import type { ReactNode } from "react";
import { DashboardNav } from "./components/dashboard-nav";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <DashboardNav />
      {children}
    </div>
  );
}
