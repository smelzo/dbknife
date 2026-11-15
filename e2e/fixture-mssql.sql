-- SQL Server counterpart of fixture-postgres.sql: recreates the dbm_test database
-- (shop tables in schema shop, column types in dbo). Batches are separated by GO:
--   sqlcmd -S <server> -U dbm_test -P test -b -i e2e/fixture-mssql.sql
USE master;
GO
IF DB_ID('dbm_test') IS NOT NULL
BEGIN
  ALTER DATABASE dbm_test SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE dbm_test;
END
GO
CREATE DATABASE dbm_test;
GO
USE dbm_test;
GO
CREATE SCHEMA shop;
GO
CREATE TABLE shop.customer (
  id int IDENTITY(1,1) CONSTRAINT pk_customer PRIMARY KEY,
  name nvarchar(100) NOT NULL,
  email nvarchar(150) NULL CONSTRAINT uq_customer_email UNIQUE,
  balance decimal(10,2) NOT NULL CONSTRAINT df_customer_balance DEFAULT 0.00,
  created_at datetime2(7) NOT NULL CONSTRAINT df_customer_created_at DEFAULT SYSDATETIME(),
  notes nvarchar(max) NULL,
  avatar varbinary(max) NULL,
  active bit NOT NULL CONSTRAINT df_customer_active DEFAULT 1,
  label AS (name + N' <' + ISNULL(email, N'-') + N'>')
);
CREATE INDEX idx_name ON shop.customer (name);
EXEC sys.sp_addextendedproperty N'MS_Description', N'Customers', N'SCHEMA', N'shop', N'TABLE', N'customer';
EXEC sys.sp_addextendedproperty N'MS_Description', N'Amount owed', N'SCHEMA', N'shop', N'TABLE', N'customer', N'COLUMN', N'balance';
CREATE TABLE shop.orders (
  id int IDENTITY(1,1) CONSTRAINT pk_orders PRIMARY KEY,
  customer_id int NOT NULL CONSTRAINT fk_orders_customer REFERENCES shop.customer (id) ON DELETE CASCADE,
  total money NOT NULL,
  status nvarchar(10) NOT NULL CONSTRAINT df_orders_status DEFAULT N'new' CONSTRAINT ck_orders_status CHECK (status IN (N'new', N'paid', N'shipped')),
  ordered_at datetime NOT NULL CONSTRAINT df_orders_ordered_at DEFAULT GETDATE()
);
CREATE INDEX fk_orders_customer_idx ON shop.orders (customer_id) INCLUDE (total);
CREATE TABLE shop.log_nopk (msg varchar(50));
INSERT INTO shop.customer (name, email, balance, notes, avatar) VALUES
 (N'Alice', N'alice@example.com', 10.50, N'first' + NCHAR(10) + N'line', 0x89504E47),
 (N'Bob', N'bob@example.com', 0, NULL, NULL),
 (N'Carla', NULL, 99.99, N'vip', NULL);
INSERT INTO shop.orders (customer_id, total, status) VALUES (1, 20.00, N'paid'), (1, 5.50, N'new'), (2, 7.00, N'shipped');
INSERT INTO shop.log_nopk VALUES ('a'), ('b');
-- decimal beyond a double's 15 digits; day 5 of month 10, read as May 10 if the literal is not ISO 8601 with T
CREATE TABLE dbo.type_samples (
  id int IDENTITY(1,1) PRIMARY KEY,
  amount decimal(38,10) NULL,
  price money NULL,
  at_datetime datetime NULL,
  at_datetime2 datetime2(7) NULL,
  at_offset datetimeoffset NULL,
  on_date date NULL,
  at_time time NULL,
  flag bit NULL,
  guid uniqueidentifier NOT NULL DEFAULT NEWID(),
  bin varbinary(16) NULL,
  doc xml NULL,
  body nvarchar(max) NULL
);
INSERT INTO dbo.type_samples (amount, price, at_datetime, at_datetime2, at_offset, on_date, at_time, flag, guid, bin, doc, body) VALUES
 (1234567890123456789012345678.0123456789, 922337203685477.5807, '2026-10-05T14:30:00', '2026-10-05T14:30:00.1234567',
  '2026-10-05T14:30:00.1234567+02:00', '2026-10-05', '14:30:00.1234567', 1, 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
  0x00FF10, N'<a x="1"><b>text</b></a>', N'àèìòù €'),
 (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, DEFAULT, NULL, NULL, NULL);
GO
CREATE VIEW shop.v_customer_orders AS
SELECT c.name, COUNT(o.id) AS n FROM shop.customer c LEFT JOIN shop.orders o ON o.customer_id = c.id GROUP BY c.name;
GO
CREATE PROCEDURE shop.add_customer @name nvarchar(100), @email nvarchar(150) = NULL
AS
BEGIN
  SET NOCOUNT ON;
  IF @email IS NULL
    INSERT INTO shop.customer (name) VALUES (@name);
  ELSE
  BEGIN
    INSERT INTO shop.customer (name, email) VALUES (@name, @email);
  END;
  SELECT SCOPE_IDENTITY() AS id;
END
GO
CREATE FUNCTION shop.customer_count() RETURNS int
AS
BEGIN
  DECLARE @n int;
  SELECT @n = COUNT(*) FROM shop.customer;
  RETURN @n;
END
GO
CREATE FUNCTION shop.customer_orders(@customer_id int) RETURNS TABLE
AS
RETURN SELECT id, total, status FROM shop.orders WHERE customer_id = @customer_id;
GO
CREATE FUNCTION shop.order_totals() RETURNS @t TABLE (customer_id int, total money)
AS
BEGIN
  INSERT INTO @t SELECT customer_id, SUM(total) FROM shop.orders GROUP BY customer_id;
  RETURN;
END
GO
CREATE TRIGGER shop.customer_ai ON shop.customer AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE c SET name = LTRIM(RTRIM(c.name)) FROM shop.customer c JOIN inserted i ON i.id = c.id;
END
GO
