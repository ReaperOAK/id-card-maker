import { describe, expect, it } from 'vitest'
import { dirname, extname, joinPath, resolvePath, stem } from '../src/paths.js'

describe('paths', () => {
  it('joins with forward slashes and collapses doubles', () => {
    expect(joinPath('a', 'b', 'c.txt')).toBe('a/b/c.txt')
    expect(joinPath('a/', '/b')).toBe('a/b')
    expect(joinPath('/abs', 'x')).toBe('/abs/x')
  })
  it('extracts a lower-cased extension and a stem', () => {
    expect(extname('photos/0101.JPG')).toBe('.jpg')
    expect(stem('photos/0101.JPG')).toBe('0101')
    expect(extname('noext')).toBe('')
    expect(stem('a/b/c.tar.gz')).toBe('c.tar')
  })
  it('takes a dirname', () => {
    expect(dirname('a/b/c.txt')).toBe('a/b')
    expect(dirname('c.txt')).toBe('.')
    expect(dirname('/c.txt')).toBe('/')
  })
  it('resolves relative to a base but leaves absolute paths alone', () => {
    expect(resolvePath('/proj', 'template.pdf')).toBe('/proj/template.pdf')
    expect(resolvePath('/proj', '/usr/share/f.ttf')).toBe('/usr/share/f.ttf')
    expect(resolvePath('C:/proj', 'D:/fonts/a.ttf')).toBe('D:/fonts/a.ttf')
  })
  it('accepts Windows backslash paths and returns forward slashes', () => {
    expect(dirname('C:\\Users\\foo\\project\\layout.json')).toBe('C:/Users/foo/project')
    expect(joinPath('C:\\Users\\foo\\project', 'fonts\\a.ttf')).toBe('C:/Users/foo/project/fonts/a.ttf')
    expect(extname('C:\\photos\\0101.JPG')).toBe('.jpg')
    expect(stem('C:\\photos\\0101.JPG')).toBe('0101')
    expect(resolvePath('C:\\proj', 'template.pdf')).toBe('C:/proj/template.pdf')
    expect(resolvePath('C:\\proj', 'D:\\fonts\\a.ttf')).toBe('D:/fonts/a.ttf')
  })
})
