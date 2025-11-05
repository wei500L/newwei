import type { ReactNode } from "react";
import { ShellLayout } from "./components/shell";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ShellLayout>{children}</ShellLayout>;
}
