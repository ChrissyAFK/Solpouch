import styles from "./InfoPage.module.css";

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
    <main id="main-content" className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>{title}</h1>
        {intro && <p className={styles.intro}>{intro}</p>}
      </header>
      <div className={styles.body}>{children}</div>
    </main>
  );
}
