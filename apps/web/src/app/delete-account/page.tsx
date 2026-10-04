import Link from "next/link";
import { ContactEmail } from "@/components/ContactEmail";
import { InfoPage } from "@/components/InfoPage";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata(
  "Delete your account",
  "How to delete your Solpouch account and what happens to your data.",
  false,
);

export default function DeleteAccountPage() {
  return (
    <InfoPage title="Delete your account" intro="You can delete your Solpouch account yourself at any time.">
      <h2>How to delete it</h2>
      <p>
        Sign in, open Profile, find the Delete account section, type DELETE and
        confirm. Deletion is immediate and cannot be undone.
      </p>
      <h2>Empty your pouches first</h2>
      <p>
        We won&apos;t delete an account while money or work is in flight. Withdraw
        or spend every pouch balance, and let any withdrawal, top-up or payment
        in progress finish. If something is blocking deletion, the page tells
        you what.
      </p>
      <h2>What is removed</h2>
      <p>
        Your profile (email, name, photo), all signed-in sessions, your pouches
        with their order, top-up and withdrawal history, your shopping lists
        and your wallet link.
      </p>
      <h2>What is kept, and why</h2>
      <p>
        Transactions already made on the Solana chain are public and cannot be
        erased by us or anyone else. Anonymous payment totals that mirror the
        public chain may remain, and they no longer connect to an account.
      </p>
      <h2>Can&apos;t sign in?</h2>
      <p>
        Contact us at <ContactEmail /> from the email address of your account
        and we will help you delete it.
      </p>
      <p>
        See also the <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </InfoPage>
  );
}
