import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { TopicsContent } from './topics-content';

export default async function TopicsPage() {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return <TopicsContent />;
}
