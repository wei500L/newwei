import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { ItemsView } from "@/app/(app)/items/items-view";

export default async function TodayPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ItemsView initialView="feed" />;
}
