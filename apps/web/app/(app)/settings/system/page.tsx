import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

type SystemSettingsPageSearchParams = Record<
  string,
  string | string[] | undefined
>;

export default async function SystemSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<SystemSettingsPageSearchParams>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries(resolvedSearchParams ?? {})) {
    if (typeof value === "string") {
      next.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        next.append(key, entry);
      }
    }
  }

  const nextQuery = next.toString();
  redirect(nextQuery ? `/admin/system?${nextQuery}` : "/admin/system");
}
