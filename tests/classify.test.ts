// Task classification: deterministic, local, and never decided by length.

import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/engine/classify.ts'

describe('simple tasks', () => {
  const simple = [
    'fix the typo in the README heading',
    'rename getUser to fetchUser in utils.ts',
    'summarize what this file does',
    'where is the retry logic defined?',
    'list all the test files',
    'what does this function do?',
  ]
  for (const prompt of simple) {
    test(`"${prompt}" is simple and low risk`, () => {
      const cls = classify(prompt)
      expect(cls.complexity).toBe('simple')
      expect(cls.risk).toBe('low')
      expect(cls.ambiguity).toBe('low')
      expect(cls.confidence).toBeGreaterThanOrEqual(0.6)
    })
  }
})

describe('standard tasks', () => {
  for (const prompt of [
    'add a unit test for the parseDate function',
    'implement a debounce hook for the search input',
    'find the bug in dates.ts and fix it',
  ]) {
    test(`"${prompt}" is standard`, () => {
      expect(classify(prompt).complexity).toBe('standard')
    })
  }

  for (const prompt of [
    'what is wrong with this code?',
    'what does this error mean and why does the build fail?',
    'what is the best way to structure the database schema for multi-tenancy?',
    'can you look at the failing tests and tell me what is going on',
  ]) {
    test(`"${prompt}" is a diagnosis or a judgment call, not a lookup`, () => {
      expect(classify(prompt).complexity).not.toBe('simple')
    })
  }

  test('a lookup is read-only; a change is not', () => {
    expect(classify('explain how the retry logic works').readOnly).toBe(true)
    expect(classify('where is the retry logic defined?').readOnly).toBe(true)
    expect(classify('add a unit test for the parseDate function').readOnly).toBe(false)
    expect(classify('rename getUser to fetchUser in utils.ts').readOnly).toBe(false)
  })

  test('an unrecognised prompt is standard at low confidence, never simple', () => {
    const cls = classify('xyzzy plugh')
    expect(cls.complexity).toBe('standard')
    expect(cls.confidence).toBeLessThan(0.5)
  })
})

describe('complex, critical and exceptional tasks', () => {
  test('a hard concurrency bug is complex', () => {
    const cls = classify('debug the intermittent deadlock in the job scheduler')
    expect(cls.complexity).toBe('complex')
    expect(cls.domains).toContain('debugging')
  })

  test('architecture work is complex and tagged architecture', () => {
    const cls = classify('design the architecture for a multi-tenant notification system')
    expect(cls.complexity).toBe('complex')
    expect(cls.domains).toContain('architecture')
  })

  test('a security audit is critical work in the security area', () => {
    const cls = classify('audit the authentication module for vulnerabilities')
    expect(cls.complexity).toBe('critical')
    expect(cls.domains).toContain('security')
  })

  test('a migration between tools is complex', () => {
    expect(classify('migrate the build from webpack to vite').complexity).toBe('complex')
  })

  test('a wide refactor of a money path is critical', () => {
    const cls = classify('refactor the payment module across all services to use the new event bus')
    expect(cls.complexity).toBe('critical')
    expect(cls.risk).toBe('high')
    expect(cls.scope).toBe('broad')
  })

  test('a production deployment is critical risk', () => {
    const cls = classify('deploy the new release to production and run the database migration')
    expect(cls.risk).toBe('critical')
    expect(cls.complexity).toBe('critical')
  })

  test('destructive SQL is critical risk', () => {
    expect(classify('drop the users table and recreate it').risk).toBe('critical')
  })

  test('formal, novel systems work is exceptional', () => {
    const cls = classify('design a novel lock-free consensus protocol and prove its correctness')
    expect(cls.complexity).toBe('exceptional')
  })
})

describe('length decides nothing', () => {
  test('a short prompt with risk words is not simple', () => {
    const cls = classify('rotate the prod api keys')
    expect(cls.complexity).not.toBe('simple')
    expect(cls.risk).toBe('high')
  })

  test('a long prompt whose only intent is a summary stays simple', () => {
    const filler = Array.from({ length: 320 }, (_, index) => `lorem${index}`).join(' ')
    const cls = classify(`Summarize the following meeting notes: ${filler}`)
    expect(cls.wordCount).toBeGreaterThan(300)
    expect(cls.complexity).toBe('simple')
  })

  test('the word "tokens" alone is not a security signal', () => {
    expect(classify('how many tokens does this prompt use?').risk).toBe('low')
  })

  test('an auth token is', () => {
    expect(classify('where do we store the refresh token?').risk).toBe('high')
  })
})

describe('ambiguity', () => {
  test('"fix it" is highly ambiguous and low confidence', () => {
    const cls = classify('fix it')
    expect(cls.ambiguity).toBe('high')
    expect(cls.confidence).toBeLessThan(0.5)
  })

  test('a vague prompt about something risky is raised, not waved through', () => {
    const cls = classify('prod is down, something is wrong, figure it out')
    expect(cls.ambiguity).toBe('high')
    expect(cls.risk).toBe('high')
    expect(['complex', 'critical', 'exceptional']).toContain(cls.complexity)
  })

  test('a symptom with a stack trace is not treated as vague', () => {
    const cls = classify('it does not work\n```\nTraceback (most recent call last)\n  File "a.py", line 3\nKeyError: 1\n```')
    expect(cls.ambiguity).not.toBe('high')
    expect(cls.domains).toContain('debugging')
  })
})

describe('explicit requests', () => {
  test('a model named in the prompt is read', () => {
    expect(classify('use opus for this: rename foo to bar').explicit.model).toBe('opus')
    expect(classify('run this on haiku please, just list the files').explicit.model).toBe('haiku')
  })

  test('a model the prompt rules out is not taken as a request for it', () => {
    expect(classify("don't use opus, keep it cheap: summarize this").explicit.model).toBeUndefined()
  })

  test('talking about models is not asking for one', () => {
    expect(classify('compare opus and sonnet pricing in a table').explicit.model).toBeUndefined()
  })

  test('an effort named in the prompt is read', () => {
    expect(classify('refactor this with max effort').explicit.effort).toBe('max')
    expect(classify('effort: low, just rename it').explicit.effort).toBe('low')
  })

  test('ultrathink is recognised', () => {
    expect(classify('ultrathink about the cache design').explicit.ultrathink).toBe(true)
  })
})

describe('follow-ups and delegation', () => {
  for (const prompt of ['ok go ahead', 'yes', 'continue', 'looks good, thanks']) {
    test(`"${prompt}" is a continuation`, () => {
      expect(classify(prompt).continuation).toBe(true)
    })
  }

  test('a real task is not a continuation', () => {
    expect(classify('ok now rewrite the whole billing service').continuation).toBe(false)
  })

  test('independent research parts suggest delegation, two at most', () => {
    const cls = classify('Research these options in parallel and compare the trade-offs:\n- Redis\n- Memcached\n- DynamoDB')
    expect(cls.delegation.suggested).toBe(true)
    expect(cls.delegation.parallel).toBeLessThanOrEqual(2)
  })

  test('a small edit suggests none', () => {
    expect(classify('fix the typo in the README heading').delegation.suggested).toBe(false)
  })

  test('"no subagents" is honoured', () => {
    const cls = classify('no subagents please: refactor the whole codebase to strict mode')
    expect(cls.explicit.noSubagents).toBe(true)
    expect(cls.delegation.suggested).toBe(false)
  })
})

test('the same prompt always classifies the same way', () => {
  const prompt = 'refactor the authentication module across all services and harden the session handling'
  expect(classify(prompt)).toEqual(classify(prompt))
})
