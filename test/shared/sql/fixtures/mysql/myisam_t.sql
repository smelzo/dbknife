CREATE TABLE `myisam_t` (
  `a` int DEFAULT NULL,
  `b` text,
  KEY `a` (`a`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3 PACK_KEYS=1 CHECKSUM=1