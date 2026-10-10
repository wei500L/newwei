/** Org scope is taken from the authenticated subscriber, never from client arguments. */
export function subscriptionPayloadMatchesOrg(payload: unknown, orgId: string): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return (payload as { orgId?: unknown }).orgId === orgId;
}
