import { PortalHomeView } from "@/app/(portal)/components/portal-shell";
import { auth } from "@/lib/auth";
import { fetchPublicPortalHome } from "@/lib/server-public-portal";

export default async function RootPage() {
  const [payload, session] = await Promise.all([fetchPublicPortalHome(), auth()]);

  return <PortalHomeView payload={payload} isAuthenticated={Boolean(session)} />;
}
