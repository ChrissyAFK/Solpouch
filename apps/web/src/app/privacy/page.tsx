import Link from "next/link";
import { ContactEmail } from "@/components/ContactEmail";
import { InfoPage } from "@/components/InfoPage";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata(
  "Privacy Policy",
  "What Solpouch stores, who processes it, and how to reach us.",
  false,
);

export default function PrivacyPage() {
  return (
    <InfoPage title="Privacy Policy" intro="Last updated October 2026.">
      <h2>What we store</h2>
      <p>
        We store your pouch settings (names, limits, and status), your orders,
        and the wallet addresses used to fund and receive payments. We do not
        store your wallet private keys.
      </p>
      <h2>Sign-in</h2>
      <p>
        Sign-in uses Google. Solpouch stores your email, name and profile
        picture to identify your pouches.
      </p>
      <h2>Voice, chat and orders</h2>
      <p>
        When live AI is enabled, chat messages, order requests and pouch context
        are processed by the configured provider, Anthropic (Claude) or Google
        (Gemini). Product searches may send the shopping request to a search provider.
        Voice sessions use ElevenLabs and its configured model; account tools are
        available only during an authenticated session you start. Basic chat uses
        preset replies without sending messages to an AI provider.
      </p>
      <h2>No selling of data</h2>
      <p>
        We do not sell your data or share it for advertising. We share it only
        with the providers needed to run the service.
      </p>
      <h2>Payments</h2>
      <p>
        In chain mode, payments use the configured Solana network, which is public.
        Wallet
        addresses and transactions are visible there and cannot be removed by
        us.
      </p>
      <h2>Deleting your account</h2>
      <p>
        You can delete your account and its data from Profile at any time. See{" "}
        <Link href="/delete-account">how to delete your account</Link>.
      </p>
      <h2>Contact</h2>
      <p>
        Questions or requests about your data:{" "}
        <ContactEmail />.
      </p>
    </InfoPage>
  );
}
