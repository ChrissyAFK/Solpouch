"use client";
import { StatePanel } from "@/components/StatePanel";

export default function ErrorPage({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl py-10" role="alert">
      <StatePanel title="This page couldn’t open" retry={retry} home>
        Something went wrong while displaying this page. Try again, or return to
        your dashboard.
      </StatePanel>
    </div>
  );
}
