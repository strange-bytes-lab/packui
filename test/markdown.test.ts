// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/ui/composables/markdown.ts'
import { normalizeRepositoryUrl } from '../src/server/api/package.ts'

/**
 * READMEs are arbitrary third-party text rendered inside a tool that can run
 * package manager commands. These tests are the contract that makes that safe.
 */
describe('markdown renderer — injection resistance', () => {
  it('escapes a raw script tag instead of emitting it', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('neutralizes inline event handlers by escaping the whole tag', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    // "onerror=" survives as literal text, which is harmless — what matters is that
    // no live element exists for it to be an attribute of.
    expect(html).not.toMatch(/<img/i)
    expect(html).toContain('&lt;img')
    expect(html).toContain('&quot;alert(1)&quot;')
  })

  it('parses its own output as inert text, not markup', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    const host = document.createElement('div')
    host.innerHTML = html
    expect(host.querySelectorAll('img')).toHaveLength(0)
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('drops a javascript: link but keeps its text', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click me')
  })

  it('drops a data: URI link', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('data:text/html')
  })

  it('drops a vbscript: link', () => {
    const html = renderMarkdown('[x](vbscript:msgbox)')
    expect(html).not.toContain('vbscript:')
  })

  it('renders images as alt text without fetching them', () => {
    const html = renderMarkdown('![build status](https://tracker.example/pixel.svg)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('tracker.example')
    expect(html).toContain('build status')
  })

  it('does not let a README forge the code-span sentinel', () => {
    const html = renderMarkdown('MDX0000000000X0MDX0000000000X and `real code`')
    expect(html).toContain('<code>real code</code>')
    expect(html).toContain('MDX0000000000X0MDX0000000000X')
  })

  it('escapes HTML inside a fenced code block', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('never emits a tag it did not construct', () => {
    const html = renderMarkdown('<iframe src="https://evil.test"></iframe>\n<style>x{}</style>')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<style')
  })
})

describe('markdown renderer — formatting', () => {
  it('renders headings, demoted so they cannot outrank the drawer heading', () => {
    expect(renderMarkdown('# Title')).toBe('<h2>Title</h2>')
    expect(renderMarkdown('###### Deep')).toContain('<h4>')
  })

  it('renders safe links with noopener', () => {
    const html = renderMarkdown('[docs](https://example.test/docs)')
    expect(html).toContain('href="https://example.test/docs"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('renders bullet and numbered lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol>')
  })

  it('renders inline code without treating its contents as markup', () => {
    const html = renderMarkdown('use `npm install **pkg**`')
    expect(html).toContain('<code>npm install **pkg**</code>')
    expect(html).not.toContain('<strong>')
  })

  it('renders emphasis and strikethrough', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>')
  })

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote>quoted</blockquote>')
    expect(renderMarkdown('---')).toContain('<hr />')
  })

  it('closes an unterminated code block rather than losing the content', () => {
    const html = renderMarkdown('```\nconst x = 1')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('</code></pre>')
    expect(html).toContain('const x = 1')
  })

  it('handles an empty README', () => {
    expect(renderMarkdown('')).toBe('')
  })
})

describe('repository URL normalization', () => {
  it.each([
    ['git+https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git+ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
    ['owner/repo', 'https://github.com/owner/repo'],
    ['github:owner/repo', 'https://github.com/owner/repo'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRepositoryUrl(input)).toBe(expected)
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd'])(
    'refuses the unsafe scheme in %s',
    (input) => {
      expect(normalizeRepositoryUrl(input)).toBeNull()
    },
  )

  it('returns null for empty or missing input', () => {
    expect(normalizeRepositoryUrl(null)).toBeNull()
    expect(normalizeRepositoryUrl('  ')).toBeNull()
  })
})
