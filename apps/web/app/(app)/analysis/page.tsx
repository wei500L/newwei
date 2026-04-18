import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { AnalysisLibrary } from "./analysis-library";

export default async function AnalysisPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <AnalysisLibrary />;
}
