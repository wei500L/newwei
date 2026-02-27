import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { auth } from "@/lib/auth";
import { AuraBackground } from "@/components/aura-background";

import { ShellLayout } from "./components/shell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <>
      <AuraBackground />
      <ShellLayout>{children}</ShellLayout>
    </>
  );
}
