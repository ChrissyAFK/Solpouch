import { pageMetadata } from "@/lib/site";

export const metadata = {
  ...pageMetadata("Overview", "Manage your pouch balances, spending limits, and orders."),
  alternates: { canonical: null },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
