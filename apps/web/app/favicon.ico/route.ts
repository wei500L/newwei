import { NextResponse } from 'next/server';

export function GET(request: Request) {
  const iconUrl = new URL('/icon.svg', request.url);
  return NextResponse.redirect(iconUrl, { status: 308 });
}
