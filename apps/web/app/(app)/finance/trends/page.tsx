import { redirect } from "next/navigation";

export default function FinanceTrendsPage() {
  redirect("/finance/macro?tab=long");
}
