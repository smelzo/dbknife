DROP DATABASE IF EXISTS shop;
CREATE DATABASE shop DEFAULT CHARACTER SET utf8mb4;
USE shop;
CREATE TABLE customer (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NULL,
  balance DECIMAL(10,2) NOT NULL DEFAULT '0.00',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  avatar BLOB,
  active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY email_UNIQUE (email),
  KEY idx_name (name)
) ENGINE=InnoDB;
CREATE TABLE orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status ENUM('new','paid','shipped') NOT NULL DEFAULT 'new',
  PRIMARY KEY (id),
  KEY fk_orders_customer_idx (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customer (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE log_nopk (msg VARCHAR(50));
INSERT INTO customer (name, email, balance, notes, avatar) VALUES
 ('Alice', 'alice@example.com', 10.50, 'first\nline', X'89504E47'),
 ('Bob', 'bob@example.com', 0, NULL, NULL),
 ('Carla', NULL, 99.99, 'vip', NULL);
INSERT INTO orders (customer_id, total, status) VALUES (1, 20.00, 'paid'), (1, 5.50, 'new'), (2, 7.00, 'shipped');
INSERT INTO log_nopk VALUES ('a'), ('b');
CREATE VIEW v_customer_orders AS SELECT c.name, COUNT(o.id) AS n FROM customer c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.name;
DELIMITER $$
CREATE PROCEDURE add_customer(IN p_name VARCHAR(100))
BEGIN
  INSERT INTO customer (name) VALUES (p_name);
  SELECT LAST_INSERT_ID() AS id;
END$$
CREATE FUNCTION customer_count() RETURNS INT DETERMINISTIC READS SQL DATA
BEGIN
  RETURN (SELECT COUNT(*) FROM customer);
END$$
CREATE TRIGGER customer_bi BEFORE INSERT ON customer FOR EACH ROW
BEGIN
  SET NEW.name = TRIM(NEW.name);
END$$
DELIMITER ;
