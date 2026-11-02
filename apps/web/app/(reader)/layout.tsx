import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { auth } from "@/lib/auth";

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
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] transition-colors duration-300">
      {children}
    </div>
  );
}
