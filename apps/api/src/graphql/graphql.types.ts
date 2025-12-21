import type { AuthenticatedUser } from "../modules/auth/auth.service";

export interface GqlRequest {
  user?: AuthenticatedUser;
}
