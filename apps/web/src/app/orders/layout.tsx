import { RequireAuth } from "@/components/AuthProvider";
import { pageMetadata } from "@/lib/site";

export const metadata = {
  ...pageMetadata("Orders", "Review your order activity and statuses."),
  alternates: { canonical: null },
};

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
