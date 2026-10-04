import { RequireAuth } from "@/components/AuthProvider";
import { pageMetadata } from "@/lib/site";

export const metadata = {
  ...pageMetadata("Profile", "Manage your Solpouch display name and profile photo."),
  alternates: { canonical: null },
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
