-- Tables covering the SHOW CREATE TABLE dialects the table editor parses.
-- Runs on MySQL 8.4 and MariaDB 11.4 (scratch schema te_scratch);
-- e2e/capture-table-fixtures.mjs stores their SHOW CREATE TABLE output.
DROP DATABASE IF EXISTS te_scratch;
CREATE DATABASE te_scratch DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE te_scratch;
CREATE TABLE parent (
  id INT NOT NULL AUTO_INCREMENT,
  code CHAR(3) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY code_UNIQUE (code)
) ENGINE=InnoDB;
CREATE TABLE kitchen (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'pk ''quoted''',
  t TINYINT(3) UNSIGNED ZEROFILL DEFAULT NULL,
  f FLOAT(7,3) DEFAULT 1.5,
  d DOUBLE NOT NULL DEFAULT 0,
  dec1 DECIMAL(12,4) DEFAULT '-1.2500',
  b BIT(8) DEFAULT b'101',
  v VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'x\'y',
  vb VARBINARY(16),
  e ENUM('a','b,c','d''e') DEFAULT 'a',
  s SET('x','y') NOT NULL DEFAULT 'x,y',
  j JSON,
  g GEOMETRY,
  pt POINT NOT NULL,
  ts TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  tn TIMESTAMP NULL DEFAULT NULL,
  dt DATETIME DEFAULT NULL,
  y YEAR,
  txt MEDIUMTEXT,
  full_name VARCHAR(81) AS (CONCAT(v, ' ', e)) VIRTUAL,
  stored_len INT AS (LENGTH(v)) STORED,
  parent_id INT,
  parent2_id INT,
  expr_def VARCHAR(36) DEFAULT (uuid()),
  next_id INT DEFAULT (parent_id + 1),
  hidden VARCHAR(5) INVISIBLE,
  PRIMARY KEY (id),
  UNIQUE KEY uq_v (v(10), dt DESC),
  KEY idx_combo (parent_id, t) USING BTREE COMMENT 'combo idx',
  FULLTEXT KEY ft_txt (txt),
  SPATIAL KEY sp_pt (pt),
  CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_parent2 FOREIGN KEY (parent2_id) REFERENCES te_scratch.parent (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT chk_d CHECK (d >= 0)
) ENGINE=InnoDB AUTO_INCREMENT=100 ROW_FORMAT=DYNAMIC COMMENT='kitchen ''sink''';
CREATE TABLE parted (
  id INT NOT NULL,
  yr INT NOT NULL,
  PRIMARY KEY (id, yr)
) ENGINE=InnoDB DEFAULT CHARSET=latin1
PARTITION BY RANGE (yr) (PARTITION p0 VALUES LESS THAN (2000), PARTITION p1 VALUES LESS THAN MAXVALUE);
CREATE TABLE myisam_t (a INT, b TEXT, KEY (a)) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3 PACK_KEYS=1 CHECKSUM=1;
CREATE TABLE plain (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NULL,
  balance DECIMAL(10,2) NOT NULL DEFAULT '0.00',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  active TINYINT(1) NOT NULL DEFAULT 1,
  parent_id INT,
  PRIMARY KEY (id),
  UNIQUE KEY email_UNIQUE (email),
  KEY idx_name (name),
  KEY fk_plain_parent_idx (parent_id),
  CONSTRAINT fk_plain_parent FOREIGN KEY (parent_id) REFERENCES parent (id) ON DELETE CASCADE
) ENGINE=InnoDB;
