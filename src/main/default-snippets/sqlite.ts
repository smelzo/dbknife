import type { SnippetSeed } from './seed'

/** Snippets for SQLite connections. */
export const sqliteSnippets: SnippetSeed[] = [
  ['SQL DML Statements', 'SELECT', 'SELECT *\nFROM table_name\nWHERE condition\nORDER BY column\nLIMIT 100;'],
  ['SQL DML Statements', 'INSERT', 'INSERT INTO table_name (col1, col2)\nVALUES (value1, value2);'],
  ['SQL DML Statements', 'UPDATE', 'UPDATE table_name\nSET col1 = value1\nWHERE condition;'],
  ['SQL DML Statements', 'DELETE', 'DELETE FROM table_name\nWHERE condition;'],
  ['SQL DML Statements', 'INSERT ... ON CONFLICT DO UPDATE', 'INSERT INTO table_name (id, col1)\nVALUES (1, value1)\nON CONFLICT (id) DO UPDATE SET col1 = excluded.col1;'],
  ['SQL DDL Statements', 'CREATE TABLE', 'CREATE TABLE table_name (\n    id INTEGER PRIMARY KEY,\n    name TEXT NOT NULL,\n    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n) STRICT;'],
  ['SQL DDL Statements', 'ADD COLUMN', 'ALTER TABLE table_name\n    ADD COLUMN column_name TEXT;'],
  ['SQL DDL Statements', 'CREATE INDEX', 'CREATE INDEX idx_name\n    ON table_name (column_name);'],
  ['SQL DDL Statements', 'CREATE TABLE with FOREIGN KEY', 'PRAGMA foreign_keys = ON;\nCREATE TABLE child (\n    id INTEGER PRIMARY KEY,\n    parent_id INTEGER NOT NULL,\n    CONSTRAINT fk_child_parent FOREIGN KEY (parent_id)\n        REFERENCES parent (id) ON DELETE CASCADE ON UPDATE CASCADE\n);'],
  ['SQL DDL Statements', 'CREATE VIEW', 'DROP VIEW IF EXISTS view_name;\nCREATE VIEW view_name AS\nSELECT col1, col2\nFROM table_name;'],
  ['DB Management', 'Integrity check', 'PRAGMA integrity_check;\nPRAGMA foreign_key_check;'],
  ['DB Management', 'List tables', "SELECT type, name\nFROM sqlite_schema\nWHERE type IN ('table', 'view')\n    AND name NOT LIKE 'sqlite_%'\nORDER BY type, name;"],
  ['DB Management', 'Table columns', 'PRAGMA table_xinfo(table_name);'],
  ['DB Management', 'Table sizes', 'SELECT name, ROUND(pgsize / 1024.0 / 1024, 2) AS size_mb\nFROM dbstat\nWHERE aggregate = TRUE\nORDER BY pgsize DESC;'],
  ['DB Management', 'VACUUM', 'VACUUM;'],
  ['DB Management', 'ATTACH DATABASE', "ATTACH DATABASE '/path/to/other.db' AS other;\nSELECT * FROM other.table_name LIMIT 100;"]
]
