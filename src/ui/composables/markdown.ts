/**
 * A deliberately small Markdown renderer for package READMEs.
 *
 * READMEs are arbitrary text published by third parties and rendered inside a tool
 * that can run package manager commands, so this renderer is built to be safe by
 * construction rather than sanitized after the fact:
 *
 * - every character is HTML-escaped first, so raw HTML in a README is shown as text
 *   and can never become live markup;
 * - only an allowlisted set of tags is ever emitted, all of them produced by this
 *   file, never copied from the input;
 * - link hrefs must parse as http, https or mailto — `javascript:` and `data:` are
 *   dropped and the link text is kept;
 * - images render as their alt text rather than being fetched. A local tool should
 *   not make requests to third-party hosts just because a README embeds a badge.
 *
 * It covers what READMEs actually use. Anything exotic degrades to plain text, which
 * is the correct direction to fail in.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function safeHref(raw: string): string | null {
  const trimmed = raw.trim()
  try {
    // A base is required so the parse succeeds; relative links resolve against it
    // and are then rejected, since a relative README link has no meaning here.
    const url = new URL(trimmed, 'https://relative.invalid/')
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null
    if (url.hostname === 'relative.invalid') return null
    return url.toString()
  } catch {
    return null
  }
}

/** Inline formatting. Input has already been HTML-escaped. */
function renderInline(text: string, sentinel: string): string {
  let output = text

  // Inline code is extracted first so its contents are never treated as emphasis
  // or as a link. The sentinel is random per render, so README text cannot forge it.
  const codeSpans: string[] = []
  output = output.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `${sentinel}${codeSpans.length - 1}${sentinel}`
  })

  // Images become their alt text; nothing is fetched.
  output = output.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => alt)

  output = output.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    (_match, label: string, href: string) => {
      const safe = safeHref(href.replace(/&amp;/g, '&'))
      if (safe === null) return label
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    },
  )

  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  output = output.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  output = output.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  const restore = new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g')
  return output.replace(restore, (_match, index: string) => codeSpans[Number(index)] ?? '')
}

export function renderMarkdown(source: string): string {
  const sentinel = `MDX${Math.random().toString(36).slice(2, 12)}X`
  const lines = escapeHtml(source).split(/\r?\n/)
  const output: string[] = []

  let inCodeBlock = false
  let listType: 'ul' | 'ol' | null = null
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    output.push(`<p>${renderInline(paragraph.join(' '), sentinel)}</p>`)
    paragraph = []
  }

  const closeList = (): void => {
    if (listType === null) return
    output.push(`</${listType}>`)
    listType = null
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph()
      closeList()
      output.push(inCodeBlock ? '</code></pre>' : '<pre><code>')
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock) {
      output.push(line)
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushParagraph()
      closeList()
      // Capped at h4 so a README cannot outrank the drawer's own heading.
      const level = Math.min(heading[1].length + 1, 4)
      output.push(`<h${level}>${renderInline(heading[2], sentinel)}</h${level}>`)
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flushParagraph()
      closeList()
      output.push('<hr />')
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet?.[1] !== undefined) {
      flushParagraph()
      if (listType !== 'ul') {
        closeList()
        output.push('<ul>')
        listType = 'ul'
      }
      output.push(`<li>${renderInline(bullet[1], sentinel)}</li>`)
      continue
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered?.[1] !== undefined) {
      flushParagraph()
      if (listType !== 'ol') {
        closeList()
        output.push('<ol>')
        listType = 'ol'
      }
      output.push(`<li>${renderInline(numbered[1], sentinel)}</li>`)
      continue
    }

    const quote = /^\s*&gt;\s?(.*)$/.exec(line)
    if (quote?.[1] !== undefined) {
      flushParagraph()
      closeList()
      output.push(`<blockquote>${renderInline(quote[1], sentinel)}</blockquote>`)
      continue
    }

    paragraph.push(line.trim())
  }

  flushParagraph()
  closeList()
  if (inCodeBlock) output.push('</code></pre>')

  return output.join('\n')
}
