CREATE TABLE IF NOT EXISTS gallery_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime_type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  caption TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  visible TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gallery_object_key (object_key),
  KEY idx_gallery_visible_order (visible, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value_text TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
