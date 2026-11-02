import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { GlobeContent } from "./globe-content";

export default async function GlobePage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <GlobeContent />;
}
