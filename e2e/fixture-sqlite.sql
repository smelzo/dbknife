-- SQLite fixture of e2e/sqlite.mjs (the same shop schema as fixture.sql)
CREATE TABLE customer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE,
  balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  avatar BLOB,
  active BOOLEAN NOT NULL DEFAULT 1
);
CREATE INDEX idx_name ON customer (name);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer (id) ON DELETE CASCADE,
  total DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'paid', 'shipped'))
);
CREATE INDEX fk_orders_customer_idx ON orders (customer_id);
CREATE TABLE log_nopk (msg VARCHAR(50));
INSERT INTO customer (name, email, balance, notes, avatar) VALUES
 ('Alice', 'alice@example.com', 10.50, 'first
line', X'89504E47'),
 ('Bob', 'bob@example.com', 0, NULL, NULL),
 ('Carla', NULL, 99.99, 'vip', NULL);
INSERT INTO orders (customer_id, total, status) VALUES (1, 20.00, 'paid'), (1, 5.50, 'new'), (2, 7.00, 'shipped');
INSERT INTO log_nopk VALUES ('a'), ('b');
CREATE VIEW v_customer_orders AS SELECT c.name, COUNT(o.id) AS n FROM customer c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.name;
CREATE TRIGGER customer_bi AFTER INSERT ON customer
BEGIN
  UPDATE customer SET name = trim(NEW.name) WHERE id = NEW.id;
END;
