import { RequireAuth } from "@/components/AuthProvider";
import { pageMetadata } from "@/lib/site";

export const metadata = {
  ...pageMetadata("Pouches", "Create pouches, add funds, and manage spending limits."),
  alternates: { canonical: null },
};

export default function PouchesLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
