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
  // A refresh failure yields a truthy session with an empty accessToken, so the
  // `!session` check above cannot catch it. Redirect here so every (app) route
  // handles an expired/errored session consistently — not only matcher routes.
  if (session.error === "RefreshAccessTokenError") {
    redirect("/login?sessionExpired=1");
  }

  return (
    <>
      <AuraBackground />
      <ShellLayout>{children}</ShellLayout>
    </>
  );
}
