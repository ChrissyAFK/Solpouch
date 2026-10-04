import { OfflineRetry } from "@/components/OfflineRetry";
import { card } from "@/components/ui";
import { pageMetadata } from "@/lib/site";

export const metadata = {
  ...pageMetadata("Offline", "Solpouch needs a connection to show balances and orders."),
  alternates: { canonical: null },
};

export default function Offline() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <h1 className="text-3xl font-semibold">You&apos;re offline</h1>
      <section className={`${card} space-y-5`} aria-label="Offline">
        <p className="text-sm leading-6 text-[var(--muted)]">
          You&apos;re offline. Solpouch needs a connection to show balances and orders.
        </p>
        <OfflineRetry />
      </section>
    </div>
  );
}
