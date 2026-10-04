import { RequireAuth } from "@/components/AuthProvider";
import { pageMetadata } from "@/lib/site";
export const metadata = pageMetadata("Shopping lists", "Save grocery lists and build fresh carts for review.");
export default function Layout({ children }: { children: React.ReactNode }) { return <RequireAuth>{children}</RequireAuth>; }
