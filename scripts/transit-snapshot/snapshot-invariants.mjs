export function patternStopPlaceMismatchQuery(version) {
  return `SELECT COUNT(*) AS count
FROM pattern_stops ps
JOIN stops s ON s.version=ps.version AND s.stop_uid=ps.stop_uid
WHERE ps.version=${sqlValue(version)} AND ps.place_id <> s.place_id`
}

function sqlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
