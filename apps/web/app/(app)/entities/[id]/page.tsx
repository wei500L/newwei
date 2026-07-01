import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { EntityIntelligenceCard } from "./entity-intelligence-card";

interface EntityDetailPageParams {
  id: string;
}

export default async function EntityDetailPage({
  params,
}: {
  params: Promise<EntityDetailPageParams>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  return <EntityIntelligenceCard entityId={id} />;
}
