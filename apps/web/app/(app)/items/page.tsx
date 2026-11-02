import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { ItemsPageHeader } from "./items-page-header";
import { ItemsView } from "./items-view";

export default async function ItemsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex flex-col gap-6">
      <ItemsPageHeader />
      <ItemsView />
    </div>
  );
}
