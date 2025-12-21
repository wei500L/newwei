import "./globals.css";
import type { ReactNode } from "react";

import { auth } from "@/lib/auth";

import { AppProviders } from "./providers";
import { SessionProviders } from "./session-provider";

export const metadata = {
  title: "Modular Admin",
  description: "Operator dashboard"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  return (
    <html lang="en">
      <body>
        <SessionProviders session={session}>
          <AppProviders>{children}</AppProviders>
        </SessionProviders>
      </body>
    </html>
  );
}
