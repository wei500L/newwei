import { SetMetadata } from "@nestjs/common";

export const ALLOW_AUTHENTICATED_KEY = "allowAuthenticated";
export const AllowAuthenticated = () => SetMetadata(ALLOW_AUTHENTICATED_KEY, true);
