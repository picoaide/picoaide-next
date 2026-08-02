import { describe, expect, it } from 'vitest'
import { buildRunConfig } from './modes'

describe('modes', () => {
  it('ask disables tools and caps at one step', () => {
    expect(buildRunConfig('ask', { a: 1 }, 20)).toEqual({ tools: {}, maxSteps: 1 })
  })

  it('plan first round disables tools and caps at one step (confirmation enables the second round)', () => {
    expect(buildRunConfig('plan', { a: 1 }, 20)).toEqual({ tools: {}, maxSteps: 1 })
  })

  it('craft keeps tools and the step budget', () => {
    const tools = { a: 1 }
    expect(buildRunConfig('craft', tools, 20)).toEqual({ tools, maxSteps: 20 })
  })
})
