import { InfoPage } from "@/components/InfoPage";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata(
  "Contact",
  "Get in touch with the Solpouch team.",
  false,
);

export default function ContactPage() {
  return (
    <InfoPage
      title="Contact"
      intro="Questions, feedback, or something not working? We read every message."
    >
      <h2>Email</h2>
      <p>
        <a href="mailto:hello@solpouch.tech">hello@solpouch.tech</a>
      </p>
      <h2>GitHub</h2>
      <p>
        <a
          href="https://github.com/ChrissyAFK/Solpouch"
          target="_blank"
          rel="noopener noreferrer"
        >
          github.com/ChrissyAFK/Solpouch
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
    </InfoPage>
  );
}
