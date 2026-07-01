import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AnalysisWorkspace } from "./analysis-workspace";

export default async function AnalysisPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AnalysisWorkspace />;
}
