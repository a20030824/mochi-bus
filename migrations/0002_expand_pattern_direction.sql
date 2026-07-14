-- TDX Direction: 0=去程、1=返程、2=迴圈。
-- SQLite 無法直接修改 CHECK constraint，因此以等價新表搬移既有資料。
CREATE TABLE patterns_direction_v2 (
  version TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  city_code TEXT NOT NULL,
  route_uid TEXT NOT NULL,
  subroute_uid TEXT,
  subroute_name TEXT NOT NULL,
  direction INTEGER NOT NULL CHECK(direction IN (0, 1, 2)),
  departure_name TEXT NOT NULL,
  destination_name TEXT NOT NULL,
  shape_key TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (version, pattern_id)
);

INSERT INTO patterns_direction_v2 (
  version, pattern_id, city_code, route_uid, subroute_uid, subroute_name,
  direction, departure_name, destination_name, shape_key, updated_at
)
SELECT
  version, pattern_id, city_code, route_uid, subroute_uid, subroute_name,
  direction, departure_name, destination_name, shape_key, updated_at
FROM patterns;

DROP TABLE patterns;
ALTER TABLE patterns_direction_v2 RENAME TO patterns;
CREATE INDEX patterns_route_idx ON patterns(version, city_code, route_uid);
