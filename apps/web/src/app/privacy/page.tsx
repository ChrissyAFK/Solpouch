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
        Chat messages, order requests and your pouch context are processed by
        Anthropic (Claude), which also searches the web when an item isn&apos;t in
        our catalog. Voice conversations run through ElevenLabs, whose agent uses a Google
        Gemini model; it reads
        your pouches only during a session you start while signed in. Demo mode
        uses preset replies without sending chat to an AI provider.
      </p>
      <h2>No selling of data</h2>
      <p>
        We do not sell your data or share it for advertising. We share it only
        with the providers needed to run the service.
      </p>
      <h2>Payments</h2>
      <p>
        In chain mode, payments use the configured Solana network, which is public.
        Demo payments are simulated. Wallet
        addresses and transactions are visible there and cannot be removed by
        us.
      </p>
      <h2>Contact</h2>
      <p>
        Questions or requests about your data:{" "}
        <a href="mailto:hello@solpouch.tech">hello@solpouch.tech</a>.
      </p>
    </InfoPage>
  );
}
