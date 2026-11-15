-- Schemas copied by e2e/copy-database.mjs, loaded on both the MySQL and the MariaDB container.
-- Dependencies run against the name order: view v_total reads view w_base, which calls
-- function f_amount; procedure a_report calls function z_count; view v_price reads a table
-- of dbm_test_cp_b. The trigger is created after the rows, which it would have changed.
DROP DATABASE IF EXISTS dbm_test_cp_a;
DROP DATABASE IF EXISTS dbm_test_cp_b;
CREATE DATABASE dbm_test_cp_a DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE dbm_test_cp_b DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE dbm_test_cp_b;
CREATE TABLE price (id INT NOT NULL PRIMARY KEY, amount DECIMAL(8,2) NOT NULL);
INSERT INTO price VALUES (1, 10.00), (2, 25.50), (3, 7.25);
-- MariaDB only (executable comment): a collation MySQL lacks
/*M!100000 CREATE TABLE label (id INT NOT NULL PRIMARY KEY, name VARCHAR(40) NOT NULL) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci */;
/*M!100000 INSERT INTO label VALUES (1, 'uno'), (2, 'due') */;

USE dbm_test_cp_a;
CREATE TABLE customer (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  code VARCHAR(20) NOT NULL
);
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  price_id INT NOT NULL,
  qty INT NOT NULL,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer (id)
);
INSERT INTO customer (name, code) VALUES ('Alice', 'a-1'), ('Bob', 'b-2'), ('Carla', 'c-3');
INSERT INTO orders (customer_id, price_id, qty) VALUES (1, 1, 2), (1, 3, 1), (2, 2, 4), (3, 1, 1);

DELIMITER $$
CREATE FUNCTION f_amount(p_qty INT, p_amount DECIMAL(8,2)) RETURNS DECIMAL(10,2) DETERMINISTIC
BEGIN
  RETURN p_qty * p_amount;
END$$
CREATE PROCEDURE a_report()
BEGIN
  SELECT z_count() AS n;
END$$
CREATE FUNCTION z_count() RETURNS INT READS SQL DATA
BEGIN
  RETURN (SELECT COUNT(*) FROM orders);
END$$
CREATE TRIGGER customer_bi BEFORE INSERT ON customer FOR EACH ROW
BEGIN
  SET NEW.code = 'by-trigger';
END$$
DELIMITER ;

CREATE VIEW v_price AS SELECT o.id, f_amount(o.qty, p.amount) AS total FROM orders o JOIN dbm_test_cp_b.price p ON p.id = o.price_id;
CREATE VIEW w_base AS SELECT c.name, f_amount(o.qty, 1) AS qty FROM customer c JOIN orders o ON o.customer_id = c.id;
CREATE VIEW v_total AS SELECT name, SUM(qty) AS qty FROM w_base GROUP BY name;
