import { RequireAuth } from "@/components/AuthProvider";
import { pageMetadata } from "@/lib/site";
export const metadata = { ...pageMetadata("Wallet funding", "Test adding and withdrawing wallet funds in US dollars or Canadian dollars."), alternates: { canonical: null }, robots: { index: false, follow: false } };
export default function FundingLayout({ children }: { children: React.ReactNode }) { return <RequireAuth>{children}</RequireAuth>; }
