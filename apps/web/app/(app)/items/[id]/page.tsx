import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { ItemDetail } from './item-detail';

interface ItemDetailPageParams {
  id: string;
}

export default async function ItemDetailPage({
  params
}: {
  params: Promise<ItemDetailPageParams>;
}) {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const { id } = await params;
  return <ItemDetail itemId={id} />;
}
