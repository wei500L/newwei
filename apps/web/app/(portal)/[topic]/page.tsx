import { redirect } from "next/navigation";

export default async function PortalTopicRedirectPage({
  params,
}: {
  params: Promise<{ topic: string }>;
}) {
  const { topic } = await params;
  redirect(`/channel/${topic}`);
}
