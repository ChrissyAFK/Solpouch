"use client";

export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#110f19",
          color: "#f1edf8",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <title>Unable to open Solpouch</title>
        <meta name="robots" content="noindex" />
        <main style={{ maxWidth: 560, margin: "15vh auto", padding: 24 }}>
          <p style={{ color: "#14f195" }}>Solpouch</p>
          <h1>We couldn’t open the dashboard</h1>
          <p style={{ color: "#a9a5b9", lineHeight: 1.6 }}>
            Something went wrong while loading the app. Try again or reload the
            overview.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "center",
              marginTop: 24,
            }}
          >
            <button
              onClick={retry}
              style={{
                background: "#9945ff",
                color: "white",
                border: 0,
                borderRadius: 4,
                padding: "12px 20px",
                font: "inherit",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a href="/" style={{ color: "#14f195", padding: "12px 0" }}>
              Back to overview
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
