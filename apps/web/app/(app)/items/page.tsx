import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { ItemsTable } from "./items-table";

export default async function ItemsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ItemsTable />;
}
