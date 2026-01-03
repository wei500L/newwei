import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { ItemDetail } from './item-detail';

interface ItemDetailPageParams {
  id: string;
}

export default async function ItemDetailPage({
  params
}: {
  params: ItemDetailPageParams;
}) {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  return <ItemDetail itemId={params.id} />;
}
