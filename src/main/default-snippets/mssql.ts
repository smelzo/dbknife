import type { SnippetSeed } from './seed'

/** Snippets for SQL Server connections. */
export const mssqlSnippets: SnippetSeed[] = [
  ['SQL DML Statements', 'SELECT', 'SELECT TOP (100) *\nFROM dbo.table_name\nWHERE condition\nORDER BY column;'],
  ['SQL DML Statements', 'SELECT ... OFFSET FETCH', 'SELECT *\nFROM dbo.table_name\nWHERE condition\nORDER BY column\nOFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY;'],
  ['SQL DML Statements', 'INSERT', 'INSERT INTO dbo.table_name (col1, col2)\nVALUES (value1, value2);'],
  ['SQL DML Statements', 'INSERT ... OUTPUT', 'INSERT INTO dbo.table_name (col1, col2)\nOUTPUT inserted.*\nVALUES (value1, value2);'],
  ['SQL DML Statements', 'UPDATE', 'UPDATE dbo.table_name\nSET col1 = value1\nWHERE condition;'],
  ['SQL DML Statements', 'DELETE', 'DELETE FROM dbo.table_name\nWHERE condition;'],
  ['SQL DML Statements', 'MERGE (upsert)', 'MERGE dbo.table_name WITH (HOLDLOCK) AS t\nUSING (VALUES (1, value1)) AS s (id, col1)\n    ON t.id = s.id\nWHEN MATCHED THEN\n    UPDATE SET t.col1 = s.col1\nWHEN NOT MATCHED THEN\n    INSERT (id, col1) VALUES (s.id, s.col1);'],
  ['SQL DDL Statements', 'CREATE TABLE', 'CREATE TABLE dbo.table_name (\n    id INT IDENTITY(1,1) NOT NULL,\n    name NVARCHAR(100) NOT NULL,\n    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_table_name PRIMARY KEY (id)\n);'],
  ['SQL DDL Statements', 'ADD COLUMN', 'ALTER TABLE dbo.table_name\n    ADD column_name NVARCHAR(45) NULL;'],
  ['SQL DDL Statements', 'CREATE INDEX', 'CREATE INDEX IX_table_name_column_name\n    ON dbo.table_name (column_name);'],
  ['SQL DDL Statements', 'ADD FOREIGN KEY', 'ALTER TABLE dbo.child\n    ADD CONSTRAINT FK_child_parent FOREIGN KEY (parent_id)\n    REFERENCES dbo.parent (id) ON DELETE CASCADE ON UPDATE CASCADE;'],
  ['SQL DDL Statements', 'CREATE OR ALTER VIEW', 'CREATE OR ALTER VIEW dbo.view_name AS\nSELECT col1, col2\nFROM dbo.table_name;'],
  ['DB Management', 'Active sessions', 'SELECT s.session_id, s.login_name, s.host_name, s.program_name,\n    DB_NAME(s.database_id) AS database_name, s.status, r.command,\n    r.wait_type, r.blocking_session_id, r.total_elapsed_time, t.text AS sql_text\nFROM sys.dm_exec_sessions AS s\nLEFT JOIN sys.dm_exec_requests AS r ON r.session_id = s.session_id\nOUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS t\nWHERE s.is_user_process = 1\nORDER BY s.session_id;'],
  ['DB Management', 'Table sizes', "SELECT s.name AS schema_name, o.name AS table_name,\n    SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS row_count,\n    CAST(SUM(p.reserved_page_count) * 8 / 1024.0 AS DECIMAL(12, 2)) AS size_mb\nFROM sys.dm_db_partition_stats AS p\nJOIN sys.objects AS o ON o.object_id = p.object_id\nJOIN sys.schemas AS s ON s.schema_id = o.schema_id\nWHERE o.type = 'U'\nGROUP BY s.name, o.name\nORDER BY size_mb DESC;"],
  ['DB Management', 'Create login and user', "CREATE LOGIN [user] WITH PASSWORD = 'password';\nCREATE USER [user] FOR LOGIN [user];\nALTER ROLE db_datareader ADD MEMBER [user];\nGRANT INSERT, UPDATE, DELETE ON SCHEMA::dbo TO [user];"],
  ['DB Management', 'Show permissions', "SELECT pe.state_desc, pe.permission_name, pe.class_desc,\n    CASE pe.class\n        WHEN 1 THEN OBJECT_SCHEMA_NAME(pe.major_id) + '.' + OBJECT_NAME(pe.major_id)\n        WHEN 3 THEN SCHEMA_NAME(pe.major_id)\n    END AS securable\nFROM sys.database_permissions AS pe\nJOIN sys.database_principals AS pr ON pr.principal_id = pe.grantee_principal_id\nWHERE pr.name = 'user'\nORDER BY pe.class_desc, securable, pe.permission_name;\n\nSELECT r.name AS role_name\nFROM sys.database_role_members AS rm\nJOIN sys.database_principals AS r ON r.principal_id = rm.role_principal_id\nJOIN sys.database_principals AS m ON m.principal_id = rm.member_principal_id\nWHERE m.name = 'user'\nORDER BY r.name;"]
]
