import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ItemsTable } from "./items-table";

export default async function ItemsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ItemsTable />;
}
