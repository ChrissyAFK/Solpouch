export function InfoPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="prose">
      <div className="page-heading" style={{ display: "block" }}>
        <h1>{title}</h1>
        {intro && <p className="page-description">{intro}</p>}
      </div>
      {children}
    </div>
  );
}
