import "./globals.css";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";

import { auth } from "@/lib/auth";

import { AppProviders } from "./providers";
import { SessionProviders } from "./session-provider";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const plexSerif = IBM_Plex_Serif({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "Modular Admin",
  description: "Operator dashboard"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  return (
    <html lang="en" className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable}`}>
      <body className="font-sans bg-background text-foreground antialiased">
        <SessionProviders session={session}>
          <AppProviders>{children}</AppProviders>
        </SessionProviders>
      </body>
    </html>
  );
}
