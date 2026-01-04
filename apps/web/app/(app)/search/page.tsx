import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { SearchContent } from "./search-content";

export default async function SearchPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <SearchContent />;
}
