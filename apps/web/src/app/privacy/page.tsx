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
      <h2>Voice and chat</h2>
      <p>
        Voice conversations with the assistant are processed by ElevenLabs.
        Text chat is processed by Google Gemini. Content you send to the
        assistant is shared with these providers so they can respond.
      </p>
      <h2>No selling of data</h2>
      <p>
        We do not sell your data or share it for advertising. We share it only
        with the providers needed to run the service.
      </p>
      <h2>Payments</h2>
      <p>
        Payments settle on the Solana blockchain, which is public. Wallet
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
