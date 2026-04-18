import { notFound } from "next/navigation";

import { PortalStoryDetailView } from "@/app/(portal)/components/portal-shell";
import { auth } from "@/lib/auth";
import { fetchPublicPortalStoryBySlug } from "@/lib/server-public-portal";

export default async function PortalArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, session] = await Promise.all([params, auth()]);
  const payload = await fetchPublicPortalStoryBySlug(slug);

  if (!payload) {
    notFound();
  }

  return <PortalStoryDetailView payload={payload} isAuthenticated={Boolean(session)} />;
}
