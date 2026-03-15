export function resolveEffectiveUserActive(
  userIsActive?: boolean | null,
  membershipIsActive?: boolean | null,
): boolean {
  return (userIsActive ?? true) && (membershipIsActive ?? true);
}
