import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { relationalStatements, splitSqlStatements } from "./sql-statements.js";

const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
const dollars = (s: string) => (s.match(/\$\$/g) ?? []).length;

describe("splitSqlStatements", () => {
  it("keeps dollar-quoted blocks whole and ignores semicolons in comments and strings", () => {
    const parts = splitSqlStatements("-- a; b\nSELECT 'x;y'; DO $$ BEGIN IF true THEN PERFORM 1; END IF; END $$; SELECT 2");
    expect(parts).toEqual(["SELECT 'x;y'", "DO $$ BEGIN IF true THEN PERFORM 1; END IF; END $$", "SELECT 2"]);
  });
  it("drops a Timescale DO block as one unit", () => {
    const sql = "SELECT 1; DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables) THEN PERFORM 1; END IF; END $$; SELECT 2;";
    expect(relationalStatements(sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("db/schema.sql statement extraction (no database)", () => {
  const all = splitSqlStatements(schema);
  const rel = relationalStatements(schema);
  it("never leaves an orphaned END or an unbalanced $$", () => {
    for (const s of all) {
      expect(s, s.slice(0, 60)).not.toMatch(/^END\b/i);
      expect(dollars(s) % 2, s.slice(0, 60)).toBe(0);
    }
  });
  it("removes Timescale statements, keeps the relational ones and the non-Timescale DO block", () => {
    expect(rel.length).toBeLessThan(all.length);
    expect(rel.length).toBeGreaterThan(15);
    for (const s of rel) expect(s).not.toMatch(/timescaledb|create_hypertable|add_compression_policy/i);
    expect(rel.some((s) => /^DO \$\$[\s\S]*vault_operations_kind_check[\s\S]*END \$\$$/i.test(s))).toBe(true);
    expect(rel.some((s) => /^DO \$\$[\s\S]*timescaledb_information/i.test(s))).toBe(false);
  });
});
