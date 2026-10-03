import { StatePanel } from "@/components/StatePanel";
import { pageMetadata } from "@/lib/site";

export const metadata = {
  ...pageMetadata(
    "Page not found",
    "This page could not be found in Solpouch.",
  ),
  alternates: { canonical: null },
};

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <h1 className="text-3xl font-semibold">404 · Page not found</h1>
      <StatePanel title="Check the link" home newOrder>
        This address doesn’t match a page. Return to your dashboard to find your
        pouches and orders.
      </StatePanel>
    </div>
  );
}
