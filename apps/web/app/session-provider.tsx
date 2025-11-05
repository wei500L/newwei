"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { PropsWithChildren } from "react";

interface SessionProvidersProps extends PropsWithChildren {
  session: Session | null;
}

export function SessionProviders({ session, children }: SessionProvidersProps) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
