import type { ReactNode } from "react";

import { FinanceNav } from "./finance-nav";

export default function FinanceLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <FinanceNav />
      {children}
    </div>
  );
}
