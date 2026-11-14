CREATE TABLE `myisam_t` (
  `a` int(11) DEFAULT NULL,
  `b` text DEFAULT NULL,
  KEY `a` (`a`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci PACK_KEYS=1 CHECKSUM=1