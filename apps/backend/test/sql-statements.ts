/**
 * Splits a SQL script into statements on top-level semicolons, keeping
 * dollar-quoted bodies ($$ ... $$ or $tag$ ... $tag$), single-quoted strings and
 * comments intact. Used by the Postgres integration fixture.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl; // drop the comment, keep the newline
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
      } else { cur += c; i++; }
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
    } else { cur += c; i++; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const TIMESCALE = /timescaledb|create_hypertable|add_compression_policy|add_continuous_aggregate_policy|add_retention_policy|CREATE MATERIALIZED VIEW|ALTER MATERIALIZED VIEW|ALTER TABLE\s+payments\s+SET/i;

/** The statements that run on plain PostgreSQL: any statement (including a whole DO block) touching TimescaleDB is dropped. */
export function relationalStatements(sql: string): string[] {
  return splitSqlStatements(sql).filter((s) => !TIMESCALE.test(s));
}
