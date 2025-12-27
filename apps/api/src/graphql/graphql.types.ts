import type { RequestWithIp } from "../common/request-ip";
import type { AuthenticatedUser } from "../modules/auth/auth.service";

export interface GqlRequest extends RequestWithIp {
  user?: AuthenticatedUser;
}
