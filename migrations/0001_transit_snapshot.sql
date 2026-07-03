CREATE TABLE dataset_versions (
  city_code TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  source_updated_at TEXT,
  imported_at TEXT NOT NULL
);

CREATE TABLE routes (
  version TEXT NOT NULL,
  city_code TEXT NOT NULL,
  route_uid TEXT NOT NULL,
  route_name TEXT NOT NULL,
  departure_name TEXT,
  destination_name TEXT,
  PRIMARY KEY (version, route_uid)
);
CREATE INDEX routes_city_name_idx ON routes(version, city_code, route_name);

CREATE TABLE patterns (
  version TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  city_code TEXT NOT NULL,
  route_uid TEXT NOT NULL,
  subroute_uid TEXT,
  subroute_name TEXT NOT NULL,
  direction INTEGER NOT NULL CHECK(direction IN (0, 1)),
  departure_name TEXT NOT NULL,
  destination_name TEXT NOT NULL,
  shape_key TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (version, pattern_id)
);
CREATE INDEX patterns_route_idx ON patterns(version, city_code, route_uid);

CREATE TABLE stop_places (
  version TEXT NOT NULL,
  place_id TEXT NOT NULL,
  city_code TEXT NOT NULL,
  place_name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  PRIMARY KEY (version, place_id)
);
CREATE INDEX stop_places_geo_idx ON stop_places(version, city_code, latitude, longitude);

CREATE TABLE stops (
  version TEXT NOT NULL,
  stop_uid TEXT NOT NULL,
  city_code TEXT NOT NULL,
  stop_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  place_id TEXT NOT NULL,
  PRIMARY KEY (version, stop_uid)
);
CREATE INDEX stops_place_idx ON stops(version, place_id);
CREATE INDEX stops_name_idx ON stops(version, city_code, normalized_name);

CREATE TABLE pattern_stops (
  version TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  stop_uid TEXT NOT NULL,
  place_id TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  PRIMARY KEY (version, pattern_id, stop_sequence)
);
CREATE INDEX pattern_stops_place_idx ON pattern_stops(version, place_id, pattern_id);
