CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entry_domain TEXT NOT NULL,
  origin_domain TEXT NOT NULL,
  fast_domain TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 100,
  tags TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lines_enabled_weight
  ON lines (enabled, weight DESC);

CREATE TABLE IF NOT EXISTS fast_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fast_domains_domain
  ON fast_domains (domain);

INSERT OR IGNORE INTO fast_domains (domain, label, is_default, created_at) VALUES
  ('youxuan.cf.090227.xyz', 'CM优选域名', 1, datetime('now')),
  ('mfa.gov.ua', '国家优选', 1, datetime('now')),
  ('store.ubi.com', '育碧优选', 1, datetime('now')),
  ('saas.sin.fan', 'MIYU优选', 1, datetime('now')),
  ('cf.tencentapp.cn', 'ktff维护优选', 1, datetime('now')),
  ('lily.lat', 'Lily姐', 1, datetime('now'));
