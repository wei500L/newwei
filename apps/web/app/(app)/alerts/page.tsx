import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

export default async function AlertsPage() {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  redirect('/subscriptions');
}
