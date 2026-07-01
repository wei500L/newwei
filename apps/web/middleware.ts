export { auth as middleware } from "@/lib/auth";

export const config = {
  // Keep in sync with the protected (app) route segments. The (app)/layout.tsx
  // also redirects errored sessions as a centralized safety net for any route.
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
    "/profile/:path*",
    "/assistant/:path*",
    "/situation-monitor/:path*",
    "/rss/:path*",
    "/events/:path*",
    "/events-archive/:path*",
    "/news-hub/:path*",
    "/newsnow/:path*",
    "/crawl/:path*"
  ]
};
