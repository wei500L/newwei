"use client";

import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import type { PropsWithChildren } from "react";

interface SessionProvidersProps extends PropsWithChildren {
  session: Session | null;
}

export function SessionProviders({ session, children }: SessionProvidersProps) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
