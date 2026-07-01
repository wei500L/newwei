import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { SearchTelemetryContent } from "./search-telemetry-content";

export default async function AdminSearchTelemetryPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SearchTelemetryContent />;
}
