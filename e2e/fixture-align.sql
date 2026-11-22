-- Alignment engine (e2e/align-engine.mjs): a source and a target schema with the
-- differences each case of the script works on. Valid on MySQL 8.4 and MariaDB 11.4,
-- with an explicit collation so that the two servers describe the same tables alike.

DROP DATABASE IF EXISTS dbm_test_al_src;
DROP DATABASE IF EXISTS dbm_test_al_dst;
CREATE DATABASE dbm_test_al_src CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE DATABASE dbm_test_al_dst CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------- source
USE dbm_test_al_src;

-- 1. keys: a latin1 key equal to the target's for its collation, BIGINT keys near 2^64
CREATE TABLE codici (code VARCHAR(10) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL PRIMARY KEY, descr VARCHAR(20) NOT NULL);
INSERT INTO codici VALUES ('abc', 'x');
CREATE TABLE big (id BIGINT UNSIGNED NOT NULL PRIMARY KEY, v INT NOT NULL);
INSERT INTO big VALUES (18446744073709551615, 1), (18446744073709551614, 2);

-- 2. a historic timestamp with ON UPDATE
CREATE TABLE storico (id INT NOT NULL PRIMARY KEY, nome VARCHAR(20) NOT NULL, ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
INSERT INTO storico VALUES (1, 'a', '2001-02-03 04:05:06');

-- 3. no key: 1,200 rows with duplicates and NULLs
CREATE TABLE log (a INT NULL, b VARCHAR(10) NULL);
INSERT INTO log (a, b)
SELECT IF(i % 7 = 0, NULL, i % 50), IF(i % 11 = 0, NULL, CONCAT('v', i % 13))
FROM (
  SELECT d1.d + 10 * d2.d + 100 * d3.d + 1000 * d4.d AS i
  FROM (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d1
  CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d2
  CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) d3
  CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1) d4
) n
WHERE i < 1200;

-- 4. defaults and a generated column (only in the source: created with its rows)
CREATE TABLE valori (
  id INT NOT NULL PRIMARY KEY,
  creato TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  n INT NOT NULL,
  m INT DEFAULT (n + 1),
  g INT AS (n * 2) STORED
);
INSERT INTO valori (id, creato, n, m) VALUES (1, '2001-01-01 00:00:00', 5, 100), (2, '2002-02-02 00:00:00', 7, 8);

-- 5. UNIQUE values taken by other rows of the target
CREATE TABLE utenti (id INT NOT NULL PRIMARY KEY, email VARCHAR(50) NOT NULL, UNIQUE KEY email (email));
INSERT INTO utenti VALUES (2, 'a');
CREATE TABLE scambi (id INT NOT NULL PRIMARY KEY, email VARCHAR(50) NOT NULL, UNIQUE KEY email (email));
INSERT INTO scambi VALUES (1, 'x'), (2, 'y');

-- 6. a parent with a column more than the target's (recreated), without the key 3 a child of the target refers to
CREATE TABLE padre (id INT NOT NULL PRIMARY KEY, nome VARCHAR(20) NOT NULL, extra INT NULL);
INSERT INTO padre VALUES (1, 'uno', NULL), (2, 'due', NULL);

-- 7. triggers: ordini of another structure, with a trigger of its own; listini_righe with rows to sync
CREATE TABLE ordini (id INT NOT NULL PRIMARY KEY, qty INT NULL, note VARCHAR(20) NULL);
INSERT INTO ordini VALUES (1, 2, 'src'), (2, 3, 'src');
CREATE TRIGGER ordini_bu BEFORE UPDATE ON ordini FOR EACH ROW SET NEW.note = IFNULL(NEW.note, 'bu');
CREATE TABLE listini_righe (id INT NOT NULL PRIMARY KEY, prezzo DECIMAL(10,2) NOT NULL);
INSERT INTO listini_righe VALUES (1, 1.50), (2, 2.00), (3, 3.00);
CREATE TABLE audit (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, what VARCHAR(50) NOT NULL);

-- 9. a view only in the source, a function of another body
CREATE VIEW v_ordini AS SELECT id, qty FROM ordini;
CREATE FUNCTION f_doppio(x INT) RETURNS INT DETERMINISTIC RETURN x * 2;

-- ---------------------------------------------------------------- target
USE dbm_test_al_dst;

CREATE TABLE codici (code VARCHAR(10) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL PRIMARY KEY, descr VARCHAR(20) NOT NULL);
INSERT INTO codici VALUES ('ABC ', 'x');
CREATE TABLE big (id BIGINT UNSIGNED NOT NULL PRIMARY KEY, v INT NOT NULL);
INSERT INTO big VALUES (18446744073709551615, 1), (18446744073709551614, 3);

CREATE TABLE storico (id INT NOT NULL PRIMARY KEY, nome VARCHAR(20) NOT NULL, ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
INSERT INTO storico VALUES (1, 'b', '2001-02-03 04:05:06');

CREATE TABLE log (a INT NULL, b VARCHAR(10) NULL);
INSERT INTO log VALUES (1, 'z'), (NULL, NULL), (NULL, NULL);

CREATE TABLE utenti (id INT NOT NULL PRIMARY KEY, email VARCHAR(50) NOT NULL, UNIQUE KEY email (email));
INSERT INTO utenti VALUES (1, 'a');
CREATE TABLE scambi (id INT NOT NULL PRIMARY KEY, email VARCHAR(50) NOT NULL, UNIQUE KEY email (email));
INSERT INTO scambi VALUES (1, 'y'), (2, 'x');

-- id 0 in an AUTO_INCREMENT column: the backup and its restore must keep it 0
CREATE TABLE padre (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(20) NOT NULL, CONSTRAINT padre_chk CHECK (nome <> ''));
SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_AUTO_VALUE_ON_ZERO');
INSERT INTO padre VALUES (0, 'zero'), (1, 'uno'), (2, 'due'), (3, 'tre');
CREATE TRIGGER padre_bi BEFORE INSERT ON padre FOR EACH ROW SET NEW.nome = UPPER(NEW.nome);
CREATE TABLE figlio (id INT NOT NULL PRIMARY KEY, padre_id INT NULL, CONSTRAINT figlio_padre FOREIGN KEY (padre_id) REFERENCES padre (id));
INSERT INTO figlio VALUES (1, 3);

CREATE TABLE ordini (id INT NOT NULL PRIMARY KEY, qty SMALLINT NULL, note VARCHAR(20) NULL);
INSERT INTO ordini VALUES (1, 2, 'dst');
CREATE TRIGGER ordini_bi BEFORE INSERT ON ordini FOR EACH ROW SET NEW.qty = IFNULL(NEW.qty, 1);
CREATE TABLE listini_righe (id INT NOT NULL PRIMARY KEY, prezzo DECIMAL(10,2) NOT NULL);
INSERT INTO listini_righe VALUES (1, 1.50), (2, 9.00);
CREATE TABLE audit (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, what VARCHAR(50) NOT NULL);
CREATE TRIGGER listini_righe_ai AFTER INSERT ON listini_righe FOR EACH ROW INSERT INTO audit (what) VALUES (CONCAT('insert ', NEW.id));
CREATE TRIGGER listini_righe_au AFTER UPDATE ON listini_righe FOR EACH ROW INSERT INTO audit (what) VALUES (CONCAT('update ', NEW.id));
CREATE TRIGGER vecchio_trg BEFORE UPDATE ON listini_righe FOR EACH ROW SET NEW.prezzo = NEW.prezzo;

CREATE TABLE scarti (id INT NOT NULL PRIMARY KEY);
INSERT INTO scarti VALUES (1);
CREATE FUNCTION f_doppio(x INT) RETURNS INT DETERMINISTIC RETURN x * 3;
