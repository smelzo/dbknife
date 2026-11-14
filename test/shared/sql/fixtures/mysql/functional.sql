CREATE TABLE `functional` (
  `a` int DEFAULT NULL,
  `b` int DEFAULT NULL,
  KEY `plain_a` (`a`),
  KEY `fx` (((`a` + `b`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci