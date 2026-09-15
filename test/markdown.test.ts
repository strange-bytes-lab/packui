// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/ui/composables/markdown.ts'
import { normalizeRepositoryUrl } from '../src/server/api/package.ts'

/**
 * READMEs are arbitrary third-party text rendered inside a tool that can run
 * package manager commands. These tests are the contract that makes that safe.
 */
describe('markdown renderer — injection resistance', () => {
  it('drops a script tag and its contents entirely', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    // The payload must not survive even as visible text.
    expect(html).not.toContain('alert(1)')
  })

  it.each(['style', 'iframe', 'noscript'])('drops a %s element and its contents', (tag) => {
    const html = renderMarkdown(`<${tag}>payload-here</${tag}>`)
    expect(html).not.toContain(`<${tag}`)
    expect(html).not.toContain('payload-here')
  })

  it('never emits an img element or its event handlers', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('keeps an image as its alt text without fetching it', () => {
    const html = renderMarkdown('<img src="https://tracker.test/p.gif" alt="build status">')
    expect(html).toContain('build status')
    expect(html).not.toContain('tracker.test')
  })

  it('parses its own output with no live script, img, iframe or handlers', () => {
    const html = renderMarkdown(
      '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<a href="javascript:alert(3)">x</a>',
    )
    const host = document.createElement('div')
    host.innerHTML = html

    expect(host.querySelectorAll('script, img, iframe, style')).toHaveLength(0)
    for (const element of host.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on')).toBe(false)
        expect(attribute.value).not.toContain('javascript:')
      }
    }
  })

  it('strips an unknown tag but keeps the text it wrapped', () => {
    const html = renderMarkdown('<div class="x"><span>visible words</span></div>')
    expect(html).not.toContain('<div')
    expect(html).not.toContain('<span')
    expect(html).toContain('visible words')
  })

  it('does not treat HTML inside a fenced code block as markup to translate', () => {
    const html = renderMarkdown('```html\n<div class="demo">sample</div>\n```')
    // The sample must survive verbatim, escaped, rather than being stripped.
    expect(html).toContain('&lt;div class=&quot;demo&quot;&gt;sample&lt;/div&gt;')
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
    const html = renderMarkdown('MDX0000000000XC0CMDX0000000000X and `real code`')
    expect(html).toContain('<code>real code</code>')
    expect(html).toContain('MDX0000000000XC0CMDX0000000000X')
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

/**
 * What real READMEs actually contain. jsdom opens with a centred HTML <h1>, most
 * popular packages lead with a badge row, and GFM tables are everywhere — all of
 * which previously rendered as literal angle-bracket noise.
 */
describe('markdown renderer — real readme constructs', () => {
  it('turns a centred HTML heading into a real heading', () => {
    const html = renderMarkdown(
      '<h1 align="center">\n    <img width="100" src="logo.svg" alt=""><br>\n    jsdom\n</h1>\n\nBody text.',
    )
    expect(html).toMatch(/<h2>\s*jsdom\s*<\/h2>/)
    expect(html).not.toContain('align=')
    expect(html).toContain('<p>Body text.</p>')
  })

  it('converts an HTML anchor into a validated link', () => {
    const html = renderMarkdown('<a href="https://example.test/docs">Docs</a>')
    expect(html).toContain('href="https://example.test/docs"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('refuses an HTML anchor with an unsafe scheme but keeps its text', () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">Click</a>')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('Click')
  })

  it('renders a GFM table', () => {
    const html = renderMarkdown(
      '| Option | Type |\n| --- | --- |\n| `root` | string |\n| `base` | string |',
    )
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Option</th>')
    expect(html).toContain('<td><code>root</code></td>')
    expect(html.match(/<tr>/g)?.length).toBe(3)
  })

  it('pads a ragged table row instead of breaking the layout', () => {
    const html = renderMarkdown('| A | B | C |\n| --- | --- | --- |\n| only-one |')
    expect(html.match(/<td>/g)?.length).toBe(3)
  })

  it('renders setext headings', () => {
    expect(renderMarkdown('Title\n=====')).toContain('<h2>Title</h2>')
    expect(renderMarkdown('Subtitle\n--------')).toContain('<h3>Subtitle</h3>')
  })

  it('still treats a bare rule as a horizontal rule', () => {
    expect(renderMarkdown('before\n\n---\n\nafter')).toContain('<hr />')
  })

  it('nests sublists rather than flattening them', () => {
    const html = renderMarkdown('- one\n  - nested\n- two')
    // Two opening <ul> means the nesting was preserved.
    expect(html.match(/<ul>/g)?.length).toBe(2)
    expect(html.match(/<\/ul>/g)?.length).toBe(2)
    expect(html).toContain('<li>nested</li>')
  })

  it('resolves reference-style links', () => {
    const html = renderMarkdown('See [the docs][d].\n\n[d]: https://example.test/docs')
    expect(html).toContain('href="https://example.test/docs"')
    expect(html).not.toContain('[d]:')
  })

  it('resolves shortcut reference links', () => {
    const html = renderMarkdown('See [docs].\n\n[docs]: https://example.test/x')
    expect(html).toContain('href="https://example.test/x"')
  })

  it('leaves an unresolved reference as plain text', () => {
    const html = renderMarkdown('See [missing][nope].')
    expect(html).toContain('[missing][nope]')
  })

  it('autolinks bare and angle-bracketed URLs', () => {
    expect(renderMarkdown('Visit https://example.test/page now')).toContain(
      'href="https://example.test/page"',
    )
    expect(renderMarkdown('<https://example.test/page>')).toContain('href=')
  })

  it('does not autolink a URL already inside a markdown link', () => {
    const html = renderMarkdown('[docs](https://example.test/page)')
    expect(html.match(/<a /g)?.length).toBe(1)
  })

  it('renders task lists as glyphs rather than inputs', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo')
    expect(html).not.toContain('<input')
    expect(html).toContain('☑')
    expect(html).toContain('☐')
  })

  it('handles a badge row without leaving angle brackets behind', () => {
    const html = renderMarkdown(
      '<p align="center">\n<a href="https://ci.test"><img src="https://img.test/b.svg" alt="CI"></a>\n</p>\n\n# Real Heading',
    )
    expect(html).not.toContain('&lt;p')
    expect(html).not.toContain('align=')
    expect(html).toContain('<h2>Real Heading</h2>')
  })

  it('keeps <br> as a line break rather than literal text', () => {
    const html = renderMarkdown('line one<br>line two')
    expect(html).not.toContain('&lt;br')
    expect(html).toContain('line one')
    expect(html).toContain('line two')
  })
})
