import type { CSSProperties, ReactNode } from "react";
import styles from "./Skeletons.module.css";

function Block({
  width = "100%",
  height = 14,
}: {
  width?: CSSProperties["width"];
  height?: number;
}) {
  return <span className={styles.block} style={{ width, height }} />;
}
function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-label={label} className={styles.loading}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
export function MetricsSkeleton() {
  return (
    <Loading label="Loading balances">
      <div className="wallet-metrics">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`wallet-metric ${i === 0 ? "main-metric" : ""}`}
          >
            <div className={styles.metric}>
              <Block width={95} />
              <Block
                width={i === 0 ? "65%" : "45%"}
                height={i === 0 ? 39 : 30}
              />
              <Block width={110} height={12} />
            </div>
          </div>
        ))}
      </div>
    </Loading>
  );
}
export function RowsSkeleton({
  kind = "pouches",
}: {
  kind?: "pouches" | "orders";
}) {
  return (
    <Loading label={`Loading ${kind}`}>
      <div className={styles.table}>
        <div className={styles.tableHeader}>
          <Block width="16%" />
          <Block width="12%" />
          <Block width="14%" />
          <Block width="10%" />
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`${styles.row} ${kind === "orders" ? styles.orderRow : ""}`}
          >
            <div className={styles.identity}>
              <Block width={i === 1 ? "65%" : "80%"} />
              <Block width="55%" height={12} />
            </div>
            <div>
              <Block width="70%" height={18} />
            </div>
            <div className={styles.detail}>
              <Block width="80%" height={12} />
              <Block height={3} />
            </div>
            <div className={styles.status}>
              <Block width={42} height={12} />
            </div>
            <div className={styles.actions}>
              <Block width={90} height={14} />
            </div>
          </div>
        ))}
      </div>
    </Loading>
  );
}
export function OrderSkeleton({ heading = false }: { heading?: boolean }) {
  return (
    <Loading label="Loading order">
      {heading && (
        <div className={styles.heading}>
          <Block width={110} height={12} />
          <Block width={190} height={30} />
          <Block width="45%" />
          <Block width={260} height={28} />
        </div>
      )}
      <div className={styles.orderGrid}>
        <div className={`sp-card ${styles.form}`}>
          <Block width={110} />
          <Block height={164} />
          <div className={styles.inline}>
            <Block width={130} height={32} />
            <Block width={90} height={32} />
          </div>
          <Block width={120} />
          <Block height={43} />
          <div className={styles.formBottom}>
            <Block width="45%" height={12} />
            <Block width={110} height={36} />
          </div>
        </div>
        <div className={styles.aside}>
          <Block width={130} />
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.asideRow}>
              <Block width={`${80 - i * 12}%`} />
            </div>
          ))}
        </div>
      </div>
    </Loading>
  );
}
export function PouchSkeleton() {
  return (
    <Loading label="Loading pouch">
      <div className={styles.heading}>
        <Block width={100} height={12} />
        <Block width={180} height={30} />
      </div>
      <div className={styles.pouchGrid}>
        <div className={styles.form}>
          <div className={styles.balance}>
            <Block width={130} />
            <Block width="55%" height={48} />
            <Block width={100} height={12} />
            <Block height={3} />
          </div>
          <div className="sp-card">
            <Block width={150} />
            <div className={styles.chart}>
              <Block width="9%" height={62} />
              <Block width="9%" height={102} />
              <Block width="9%" height={82} />
              <Block width="9%" height={128} />
              <Block width="9%" height={94} />
            </div>
          </div>
        </div>
        <div className={`sp-card ${styles.form}`}>
          <Block width={155} height={18} />
          <Block width="85%" />
          <Block width={105} />
          <Block height={43} />
          <Block width={105} />
          <Block height={43} />
          <Block width={145} />
          <Block height={50} />
          <Block height={50} />
          <Block width={115} height={36} />
        </div>
      </div>
    </Loading>
  );
}
export function OverviewSkeleton() {
  return (
    <>
      <div className="page-heading">
        <h1>Overview</h1>
      </div>
      <MetricsSkeleton />
      <section className="wallet-section">
        <div className="section-heading">
          <h2>Pouches</h2>
        </div>
        <RowsSkeleton />
      </section>
      <section className="wallet-section">
        <div className="section-heading">
          <h2>Orders</h2>
        </div>
        <RowsSkeleton kind="orders" />
      </section>
    </>
  );
}
