import type { ReactNode } from "react";

import { DashboardNav } from "./components/dashboard-nav";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <DashboardNav />
      {children}
    </div>
  );
}
