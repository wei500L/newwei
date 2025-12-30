export { auth as middleware } from "@/lib/auth";

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/items/:path*",
    "/today/:path*",
    "/topics/:path*",
    "/map/:path*",
    "/finance/:path*",
    "/alerts/:path*",
    "/search/:path*",
    "/subscriptions/:path*",
    "/admin/:path*",
    "/settings/:path*",
    "/profile/:path*"
  ]
};
