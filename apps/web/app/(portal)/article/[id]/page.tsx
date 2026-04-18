import { notFound, redirect } from "next/navigation";

import { fetchPublicPortalStoryById } from "@/lib/server-public-portal";

export default async function PortalArticleIdRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const payload = await fetchPublicPortalStoryById(id);

  if (!payload) {
    notFound();
  }

  redirect(`/article/${payload.story.slug}`);
}
