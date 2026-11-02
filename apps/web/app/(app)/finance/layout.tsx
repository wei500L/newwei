import type { ReactNode } from "react";

import { FinanceNav } from "./finance-nav";

export default function FinanceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <FinanceNav />
      {children}
    </div>
  );
}
