import type { SnippetSeed } from './seed'

/** Snippets for MySQL and MariaDB connections. */
export const mysqlSnippets: SnippetSeed[] = [
  ['SQL DML Statements', 'SELECT', 'SELECT *\nFROM table_name\nWHERE condition\nORDER BY column\nLIMIT 100;'],
  ['SQL DML Statements', 'INSERT', 'INSERT INTO table_name (col1, col2)\nVALUES (value1, value2);'],
  ['SQL DML Statements', 'UPDATE', 'UPDATE table_name\nSET col1 = value1\nWHERE condition;'],
  ['SQL DML Statements', 'DELETE', 'DELETE FROM table_name\nWHERE condition;'],
  ['SQL DML Statements', 'INSERT ... ON DUPLICATE KEY UPDATE', 'INSERT INTO table_name (id, col1)\nVALUES (1, value1)\nON DUPLICATE KEY UPDATE col1 = VALUES(col1);'],
  ['SQL DDL Statements', 'CREATE TABLE', 'CREATE TABLE table_name (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    name VARCHAR(100) NOT NULL,\n    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (id)\n) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;'],
  ['SQL DDL Statements', 'ADD COLUMN', 'ALTER TABLE table_name\n    ADD COLUMN column_name VARCHAR(45) NULL AFTER other_column;'],
  ['SQL DDL Statements', 'ADD INDEX', 'ALTER TABLE table_name\n    ADD INDEX idx_name (column_name);'],
  ['SQL DDL Statements', 'ADD FOREIGN KEY', 'ALTER TABLE child\n    ADD CONSTRAINT fk_child_parent FOREIGN KEY (parent_id)\n    REFERENCES parent (id) ON DELETE CASCADE ON UPDATE CASCADE;'],
  ['SQL DDL Statements', 'CREATE VIEW', 'CREATE OR REPLACE VIEW view_name AS\nSELECT col1, col2\nFROM table_name;'],
  ['DB Management', 'Show processlist', 'SHOW FULL PROCESSLIST;'],
  ['DB Management', 'Table sizes', "SELECT TABLE_NAME, ENGINE, TABLE_ROWS,\n    ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS size_mb\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = DATABASE()\nORDER BY size_mb DESC;"],
  ['DB Management', 'Create user', "CREATE USER 'user'@'%' IDENTIFIED BY 'password';\nGRANT SELECT, INSERT, UPDATE, DELETE ON db.* TO 'user'@'%';"],
  ['DB Management', 'Show grants', "SHOW GRANTS FOR 'user'@'%';"]
]
