import "./globals.css";
import type { ReactNode } from "react";
import { Inter, Roboto_Mono } from "next/font/google";

import { auth } from "@/lib/auth";

import { AppProviders } from "./providers";
import { SessionProviders } from "./session-provider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-roboto-mono",
  display: "swap",
});

export const metadata = {
  title: "Modular Admin",
  description: "Operator dashboard"
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  return (
    <html lang="en" className={`${inter.variable} ${robotoMono.variable}`}>
      <body className="font-sans bg-background text-foreground antialiased">
        <SessionProviders session={session}>
          <AppProviders>{children}</AppProviders>
        </SessionProviders>
      </body>
    </html>
  );
}
