import { InfoPage } from "@/components/InfoPage";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata(
  "Terms of Service",
  "The terms for using Solpouch.",
  false,
);

export default function TermsPage() {
  return (
    <InfoPage title="Terms of Service" intro="Last updated October 2026.">
      <h2>Using Solpouch</h2>
      <p>
        By using Solpouch you agree to these terms. Solpouch lets you set up
        budget pouches and have an assistant prepare orders for your approval.
      </p>
      <h2>Approval</h2>
      <p>
        The assistant never pays without your approval. An order is paid only
        after the owner approves it.
      </p>
      <h2>Your wallet</h2>
      <p>
        You are responsible for your wallet and its keys. We cannot recover
        lost keys or reverse blockchain transactions.
      </p>
      <h2>No financial advice</h2>
      <p>
        Solpouch is a budgeting and ordering tool. Nothing in it is financial,
        investment, or tax advice.
      </p>
      <h2>Service as is</h2>
      <p>
        The service is provided as is, without warranties of any kind. To the
        extent the law allows, we are not liable for losses arising from its
        use, including product availability, pricing, or network issues.
      </p>
      <h2>Contact</h2>
      <p>
        Questions about these terms:{" "}
        <a href="mailto:hello@solpouch.tech">hello@solpouch.tech</a>.
      </p>
    </InfoPage>
  );
}
