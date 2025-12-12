import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ErrorsContent } from "./errors-content";

export default async function ErrorsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <ErrorsContent />;
}

