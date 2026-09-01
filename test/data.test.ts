import { describe, expect, it } from 'vitest'
import { findDuplicateIds, loadRows, normaliseHeader, normaliseId } from '../src/data.js'

describe('normaliseId', () => {
  it('strips case, punctuation and leading zeros', () => {
    expect(normaliseId('0101')).toBe('101')
    expect(normaliseId('101')).toBe('101')
    expect(normaliseId(' ID-101 ')).toBe('id101')
    expect(normaliseId('ADM/007')).toBe('adm7')
  })

  it('keeps a bare zero rather than emptying it', () => {
    expect(normaliseId('0')).toBe('0')
    expect(normaliseId('000')).toBe('0')
  })

  it('returns an empty string for a missing id, distinct from an id of zero', () => {
    expect(normaliseId('')).toBe('')
    expect(normaliseId('   ')).toBe('')
    expect(normaliseId('---')).toBe('')
    // A real id of zero must NOT look like a missing one.
    expect(normaliseId('0')).toBe('0')
  })
})

describe('normaliseHeader', () => {
  it('folds curly apostrophes and collapses whitespace', () => {
    // \u2019 is the curly apostrophe real spreadsheets carry; written as an
    // escape so it cannot be flattened to an ASCII quote by an editor.
    expect(normaliseHeader('  Guardian\u2019s   Name ')).toBe("Guardian's Name")
    expect(normaliseHeader('Guardian\u2018s Name')).toBe("Guardian's Name")
    expect(normaliseHeader('ID No.')).toBe('ID No.')
  })
})

describe('loadRows', () => {
  it('reads every data row from an xlsx file', async () => {
    const { headers, rows } = await loadRows('fixtures/students.xlsx')
    expect(headers).toContain('ID No.')
    expect(headers).toContain("Guardian's Name")
    expect(rows).toHaveLength(4)
    expect(rows[0]?.values['Name']).toBe('Rahul Kumar')
    expect(rows[0]?.index).toBe(2)
  })

  it('returns an empty string for a blank cell rather than undefined', async () => {
    const { rows } = await loadRows('fixtures/students.xlsx')
    expect(rows[2]?.values['Blood Group']).toBe('')
  })
})

describe('findDuplicateIds', () => {
  it('reports ids appearing on more than one row', async () => {
    const { rows } = await loadRows('fixtures/students.xlsx')
    const dupes = findDuplicateIds(rows, 'ID No.')
    expect([...dupes.keys()]).toEqual(['102'])
    expect(dupes.get('102')).toEqual([3, 5])
  })
})
