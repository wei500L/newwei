import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { ItemsView } from "./items-view";

export default async function ItemsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ItemsView />;
}
