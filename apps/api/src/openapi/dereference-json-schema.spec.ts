import { describe, expect, it } from 'vitest'
import { dereferenceOwnDefs } from './dereference-json-schema.js'

describe('dereferenceOwnDefs', () => {
  it('resolves the top-level $ref and inlines every nested one, dropping $schema/$defs', () => {
    const entry = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Widget',
      $defs: {
        Widget: {
          type: 'object',
          properties: { size: { $ref: '#/$defs/Size' } },
        },
        Size: { type: 'string', enum: ['small', 'large'] },
      },
    }

    expect(dereferenceOwnDefs(entry)).toEqual({
      type: 'object',
      properties: { size: { type: 'string', enum: ['small', 'large'] } },
    })
  })

  it('resolves the same nested id independently inside arrays and nested objects', () => {
    const entry = {
      $ref: '#/$defs/Root',
      $defs: {
        Root: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: '#/$defs/Leaf' } },
            nested: { type: 'object', properties: { again: { $ref: '#/$defs/Leaf' } } },
          },
        },
        Leaf: { type: 'string' },
      },
    }

    expect(dereferenceOwnDefs(entry)).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { again: { type: 'string' } } },
      },
    })
  })

  it('throws on a dangling $ref rather than silently emitting one', () => {
    const entry = { $ref: '#/$defs/Missing', $defs: {} }
    expect(() => dereferenceOwnDefs(entry)).toThrow(/dangling/)
  })

  it('throws on a cyclic $ref rather than recursing forever', () => {
    const entry = {
      $ref: '#/$defs/A',
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
    }
    expect(() => dereferenceOwnDefs(entry)).toThrow(/cyclic/)
  })
})
