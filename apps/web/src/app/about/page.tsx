import { InfoPage } from "@/components/InfoPage";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata(
  "About",
  "Solpouch is AI-shopped budget pouches paid in USDC on Solana.",
  false,
);

export default function AboutPage() {
  return (
    <InfoPage
      title="About Solpouch"
      intro="Budget pouches that an assistant can shop from, with you approving every order."
    >
      <h2>Pouches</h2>
      <p>
        A pouch is a budget for one purpose. Each pouch has a daily limit and a
        per-order cap, so spending stays inside the boundaries you set.
      </p>
      <h2>An assistant that builds the cart</h2>
      <p>
        Tell the assistant what you need by voice or text. It finds matching
        items and builds a cart from the stores available to your pouch.
      </p>
      <h2>Every order waits for you</h2>
      <p>
        The assistant never pays on its own. Each order stays a draft until the
        owner reviews and approves it.
      </p>
      <h2>Payments in USDC on Solana</h2>
      <p>
        Approved orders settle in USDC on Solana, and every payment has a
        transaction you can view.
      </p>
      <h2>Freeze anytime</h2>
      <p>
        You can freeze any pouch instantly. A frozen pouch cannot be used for
        new orders until you unfreeze it.
      </p>
    </InfoPage>
  );
}
