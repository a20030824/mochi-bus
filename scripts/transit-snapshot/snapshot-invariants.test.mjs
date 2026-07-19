import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { patternStopPlaceMismatchQuery } from './snapshot-invariants.mjs'

describe('remote snapshot invariants', () => {
  it('counts pattern-stop place IDs that differ from the canonical stop', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE stops (version TEXT, stop_uid TEXT, place_id TEXT)')
      db.exec('CREATE TABLE pattern_stops (version TEXT, pattern_id TEXT, stop_uid TEXT, place_id TEXT)')
      db.exec("INSERT INTO stops VALUES ('v1', 'TAO1054', 'B')")
      db.exec("INSERT INTO pattern_stops VALUES ('v1', 'P1', 'TAO1054', 'A')")
      db.exec("INSERT INTO pattern_stops VALUES ('v1', 'P2', 'TAO1054', 'B')")
      expect(db.prepare(patternStopPlaceMismatchQuery('v1')).get().count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('escapes the version literal', () => {
    expect(patternStopPlaceMismatchQuery("v'1")).toContain("'v''1'")
  })
})
