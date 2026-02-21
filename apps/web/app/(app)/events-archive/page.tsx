import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { EventsArchiveContent } from "./events-archive-content";

export default async function EventsArchivePage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <EventsArchiveContent />;
}
