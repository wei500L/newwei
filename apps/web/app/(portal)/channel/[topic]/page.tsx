import { notFound } from "next/navigation";

import { PortalChannelView } from "@/app/(portal)/components/portal-shell";
import { auth } from "@/lib/auth";
import { fetchPublicPortalChannel } from "@/lib/server-public-portal";

export default async function PortalChannelPage({
  params,
}: {
  params: Promise<{ topic: string }>;
}) {
  const [{ topic }, session] = await Promise.all([params, auth()]);
  const payload = await fetchPublicPortalChannel(topic);

  if (!payload) {
    notFound();
  }

  return <PortalChannelView payload={payload} isAuthenticated={Boolean(session)} />;
}
