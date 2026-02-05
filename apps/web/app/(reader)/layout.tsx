import type { ReactNode } from "react";

import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function ReaderLayout({
  children
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100 transition-colors duration-300">
      {children}
    </div>
  );
}
