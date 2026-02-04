import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { EventDetail } from "./event-detail";

interface EventDetailPageParams {
  id: string;
}

export default async function EventDetailPage({ params }: { params: EventDetailPageParams }) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <EventDetail eventId={params.id} />;
}

