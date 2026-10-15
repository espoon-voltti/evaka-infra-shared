import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

import { s3Stub } from './stub-s3.mjs'
import {
  DAY_MS,
  STATE_KEY,
  bucketStarts,
  dayKey,
  dayKeysForRange,
  decodeDay,
  encodeDay,
  readDay,
  readState,
  splitIntoChunks,
  toSlots,
  upsertDay,
  upsertSlots,
  writeState,
  zeroFill
} from './store.mjs'

const ms = (iso) => Date.parse(iso)

describe('dayKey', () => {
  it('uses the UTC date', () => {
    assert.equal(dayKey(ms('2026-10-05T23:55:00Z')), '5min/2026/10/05.json')
    assert.equal(
      dayKey(ms('2026-10-06T00:30:00+03:00')),
      '5min/2026/10/05.json'
    )
  })
})

describe('dayKeysForRange', () => {
  it('gives one key for each UTC day that overlaps the range', () => {
    assert.deepEqual(
      dayKeysForRange(ms('2026-10-05T00:00Z'), ms('2026-10-06T12:00Z')),
      ['5min/2026/10/05.json', '5min/2026/10/06.json']
    )
  })

  it('leaves out the day that starts at the exclusive end of the range', () => {
    assert.deepEqual(
      dayKeysForRange(ms('2026-10-05T12:00Z'), ms('2026-10-06T00:00Z')),
      ['5min/2026/10/05.json']
    )
  })

  it('crosses month and year ends', () => {
    assert.deepEqual(
      dayKeysForRange(ms('2026-12-31T23:00Z'), ms('2027-01-01T01:00Z')),
      ['5min/2026/12/31.json', '5min/2027/01/01.json']
    )
  })
})

describe('splitIntoChunks', () => {
  it('splits a range at UTC midnights with day chunks', () => {
    assert.deepEqual(
      splitIntoChunks(ms('2026-10-05T22:00Z'), ms('2026-10-07T01:00Z'), DAY_MS),
      [
        { fromMs: ms('2026-10-05T22:00Z'), toMs: ms('2026-10-06T00:00Z') },
        { fromMs: ms('2026-10-06T00:00Z'), toMs: ms('2026-10-07T00:00Z') },
        { fromMs: ms('2026-10-07T00:00Z'), toMs: ms('2026-10-07T01:00Z') }
      ]
    )
  })

  it('ends chunks at multiples of the chunk length', () => {
    assert.deepEqual(
      splitIntoChunks(
        ms('2026-10-05T03:00Z'),
        ms('2026-10-06T06:00Z'),
        DAY_MS / 2
      ),
      [
        { fromMs: ms('2026-10-05T03:00Z'), toMs: ms('2026-10-05T12:00Z') },
        { fromMs: ms('2026-10-05T12:00Z'), toMs: ms('2026-10-06T00:00Z') },
        { fromMs: ms('2026-10-06T00:00Z'), toMs: ms('2026-10-06T06:00Z') }
      ]
    )
  })

  it('gives nothing for an empty range', () => {
    assert.deepEqual(
      splitIntoChunks(ms('2026-10-05T00:00Z'), ms('2026-10-05T00:00Z'), DAY_MS),
      []
    )
  })
})

describe('bucketStarts', () => {
  it('gives the 5-minute starts inside the range, end excluded', () => {
    assert.deepEqual(
      bucketStarts(ms('2026-10-05T00:00Z'), ms('2026-10-05T00:15Z')),
      [
        ms('2026-10-05T00:00Z'),
        ms('2026-10-05T00:05Z'),
        ms('2026-10-05T00:10Z')
      ]
    )
  })

  it('gives 288 buckets for a day', () => {
    assert.equal(
      bucketStarts(ms('2026-10-05T00:00Z'), ms('2026-10-06T00:00Z')).length,
      288
    )
  })
})

describe('zeroFill', () => {
  const counter = { type: 'counter' }
  const histogram = { type: 'histogram', bounds: [10, 100] }

  it('adds a zero for each missing counter in each bucket of the range', () => {
    const t0 = ms('2026-10-05T00:00Z')
    const t1 = ms('2026-10-05T00:05Z')
    const filled = zeroFill(new Map([[t0, { a: 3, other: 1 }]]), [t0, t1], {
      a: counter,
      b: counter
    })
    assert.deepEqual(
      [...filled],
      [
        [t0, { a: 3, other: 1, b: 0 }],
        [t1, { a: 0, b: 0 }]
      ]
    )
  })

  it('adds all-zero counts for a missing histogram and keeps a stored one', () => {
    const t0 = ms('2026-10-05T00:00Z')
    const t1 = ms('2026-10-05T00:05Z')
    const filled = zeroFill(new Map([[t0, { h: [1, 0, 2] }]]), [t0, t1], {
      h: histogram
    })
    assert.deepEqual(filled.get(t0), { h: [1, 0, 2] })
    assert.deepEqual(filled.get(t1), { h: [0, 0, 0] })
  })

  it('gives each bucket its own histogram array', () => {
    const t0 = ms('2026-10-05T00:00Z')
    const t1 = ms('2026-10-05T00:05Z')
    const filled = zeroFill(new Map(), [t0, t1], { h: histogram })
    filled.get(t0).h[0] = 5
    assert.deepEqual(filled.get(t1).h, [0, 0, 0])
  })

  it('does not add buckets outside the range', () => {
    const outside = ms('2026-10-04T23:55Z')
    const filled = zeroFill(
      new Map([[outside, { x: { min: 1 } }]]),
      [ms('2026-10-05T00:00Z')],
      { a: counter }
    )
    // The bucket outside the range keeps its values and gets no counter keys.
    assert.deepEqual(filled.get(outside), { x: { min: 1 } })
  })

  it('throws for a series that has no zero value', () => {
    assert.throws(
      () =>
        zeroFill(new Map(), [ms('2026-10-05T00:00Z')], {
          'rds.cpu': { type: 'gaugeSummary' }
        }),
      /gaugeSummary/
    )
  })
})

describe('toSlots', () => {
  it('sorts by time and puts t first', () => {
    const slots = toSlots(
      new Map([
        [ms('2026-10-05T00:05Z'), { a: 2 }],
        [ms('2026-10-05T00:00Z'), { a: 1 }]
      ])
    )
    assert.deepEqual(slots, [
      { t: '2026-10-05T00:00:00Z', a: 1 },
      { t: '2026-10-05T00:05:00Z', a: 2 }
    ])
    assert.deepEqual(Object.keys(slots[0]), ['t', 'a'])
  })
})

describe('upsertSlots', () => {
  const day = {
    series: { a: { type: 'counter' } },
    slots: [
      { t: '2026-10-05T00:00:00Z', a: 1 },
      { t: '2026-10-05T00:10:00Z', a: 5, b: { min: 1, mean: 2, max: 3, n: 5 } }
    ]
  }

  it('inserts new slots in time order and merges series', () => {
    const result = upsertSlots(day, { b: { type: 'gaugeSummary' } }, [
      { t: '2026-10-05T00:05:00Z', a: 2 }
    ])
    assert.deepEqual(result.series, {
      a: { type: 'counter' },
      b: { type: 'gaugeSummary' }
    })
    assert.deepEqual(
      result.slots.map((s) => s.t),
      ['2026-10-05T00:00:00Z', '2026-10-05T00:05:00Z', '2026-10-05T00:10:00Z']
    )
  })

  it('replaces the keys of a slot with the same t and keeps its other keys', () => {
    const result = upsertSlots(day, {}, [{ t: '2026-10-05T00:10:00Z', a: 7 }])
    assert.deepEqual(result.slots[1], {
      t: '2026-10-05T00:10:00Z',
      a: 7,
      b: { min: 1, mean: 2, max: 3, n: 5 }
    })
  })

  it('replaces a histogram of a slot as one value and keeps its bounds', () => {
    const histogram = { type: 'histogram', bounds: [10, 100] }
    const stored = upsertSlots(day, { h: histogram }, [
      { t: '2026-10-05T00:10:00Z', h: [1, 2, 3] }
    ])
    const result = upsertSlots(stored, { h: histogram }, [
      { t: '2026-10-05T00:10:00Z', h: [0, 4, 0] }
    ])
    assert.deepEqual(result.series.h, histogram)
    assert.deepEqual(result.slots[1], {
      t: '2026-10-05T00:10:00Z',
      a: 5,
      b: { min: 1, mean: 2, max: 3, n: 5 },
      h: [0, 4, 0]
    })
  })

  it('is idempotent', () => {
    const slots = [{ t: '2026-10-05T00:05:00Z', a: 2 }]
    const once = upsertSlots(day, {}, slots)
    assert.deepEqual(upsertSlots(once, {}, slots), once)
  })

  it('does not change the input day', () => {
    const copy = structuredClone(day)
    upsertSlots(day, { c: { type: 'counter' } }, [
      { t: '2026-10-05T00:00:00Z', a: 9 }
    ])
    assert.deepEqual(day, copy)
  })
})

describe('encodeDay and decodeDay', () => {
  it('round-trip through gzip', () => {
    const day = {
      series: { a: { type: 'counter' } },
      slots: [{ t: '2026-10-05T00:00:00Z', a: 1 }]
    }
    const bytes = encodeDay(day)
    assert.deepEqual(JSON.parse(gunzipSync(bytes)), day)
    assert.deepEqual(decodeDay(bytes), day)
  })
})

describe('readDay and upsertDay', () => {
  beforeEach(() => s3Stub.reset())

  it('gives an empty day when the object does not exist', async () => {
    assert.deepEqual(await readDay('bucket', '5min/2026/10/05.json'), {
      series: {},
      slots: []
    })
  })

  it('writes gzip JSON with its content headers and merges into the stored file', async () => {
    const key = '5min/2026/10/05.json'
    await upsertDay('bucket', key, { a: { type: 'counter' } }, [
      { t: '2026-10-05T00:00:00Z', a: 1 }
    ])
    await upsertDay('bucket', key, { a: { type: 'counter' } }, [
      { t: '2026-10-05T00:05:00Z', a: 2 }
    ])

    const object = s3Stub.objects.get(key)
    assert.equal(object.Bucket, 'bucket')
    assert.equal(object.ContentType, 'application/json')
    assert.equal(object.ContentEncoding, 'gzip')
    assert.deepEqual(decodeDay(object.Body).slots, [
      { t: '2026-10-05T00:00:00Z', a: 1 },
      { t: '2026-10-05T00:05:00Z', a: 2 }
    ])
  })

  it('gives an empty day for a 404 without the NoSuchKey name', async () => {
    const notFound = Object.assign(new Error('UnknownError'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 }
    })
    s3Stub.objects = {
      get: () => {
        throw notFound
      }
    }
    assert.deepEqual(await readDay('bucket', 'k'), { series: {}, slots: [] })
  })

  it('passes on errors other than a missing key', async () => {
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied'
    })
    s3Stub.objects = {
      get: () => {
        throw denied
      }
    }
    await assert.rejects(readDay('bucket', 'k'), denied)
  })
})

describe('readState and writeState', () => {
  beforeEach(() => s3Stub.reset())

  it('gives an empty state when the object does not exist', async () => {
    assert.deepEqual(await readState('bucket'), {})
  })

  it('writes plain JSON and reads it back', async () => {
    const state = { service: '2026-10-06T12:00:00Z' }
    await writeState('bucket', state)
    const object = s3Stub.objects.get(STATE_KEY)
    assert.equal(object.ContentType, 'application/json')
    assert.equal(object.ContentEncoding, undefined)
    assert.deepEqual(await readState('bucket'), state)
  })
})
