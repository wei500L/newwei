import { redirect } from "next/navigation";

export default function FinanceKeyMonitorPage() {
  redirect("/finance?tab=monitor");
}
