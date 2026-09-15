/**
 * A Markdown renderer for package READMEs.
 *
 * READMEs are arbitrary text published by third parties, rendered inside a tool that
 * can run package manager commands. The renderer is therefore safe by construction
 * rather than sanitized after the fact:
 *
 * - every character is HTML-escaped before any markup is produced, so nothing from
 *   the source can become live markup;
 * - only an allowlisted set of tags is ever emitted, all of them written by this file
 *   and never copied from the input;
 * - link hrefs must parse as http, https or mailto — `javascript:` and `data:` are
 *   dropped and the link text kept;
 * - images render as their alt text rather than being fetched, because a local tool
 *   should not call out to third-party hosts just because a readme embeds a badge.
 *
 * Real READMEs lean heavily on raw HTML — centred headers, badge rows, `<br>` — so
 * escaping it and leaving it visible produced walls of literal `<h1 align="center">`
 * text. HTML is instead translated to Markdown *before* escaping, and any tag without
 * a translation is dropped while keeping its text. Nothing attacker-controlled ever
 * survives into the output; the translation only ever yields Markdown this file then
 * renders itself.
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
  try {
    // A base is required so the parse succeeds; relative links resolve against it and
    // are then rejected, since a relative readme link has no meaning in this app.
    const url = new URL(raw.trim(), 'https://relative.invalid/')
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null
    if (url.hostname === 'relative.invalid') return null
    return url.toString()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Phase 1 — protect code, translate HTML, collect link definitions
 * ------------------------------------------------------------------ */

interface Protected {
  text: string
  blocks: string[]
}

/**
 * Fenced and indented code must survive HTML translation untouched: a readme showing
 * an HTML example would otherwise have its own sample code stripped out of it.
 */
function protectCode(source: string, sentinel: string): Protected {
  const blocks: string[] = []

  const withFences = source.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, (match) => {
    blocks.push(match)
    return `${sentinel}${blocks.length - 1}${sentinel}`
  })

  const withInline = withFences.replace(/`[^`\n]+`/g, (match) => {
    blocks.push(match)
    return `${sentinel}${blocks.length - 1}${sentinel}`
  })

  return { text: withInline, blocks }
}

function restoreCode(text: string, blocks: string[], sentinel: string): string {
  return text.replace(
    new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g'),
    (_match, index: string) => blocks[Number(index)] ?? '',
  )
}

/**
 * Translates the HTML that READMEs actually use into Markdown, then drops every
 * remaining tag while keeping its text.
 */
function htmlToMarkdown(source: string): string {
  let text = source

  // Comments, and elements whose *content* must go too rather than be kept as text.
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(script|style|iframe|noscript)\b[\s\S]*?<\/\1>/gi, '')

  // Angle-bracket autolinks must be converted before the tag stripper runs, or
  // `<https://example.test>` looks exactly like a tag and gets eaten.
  text = text.replace(
    /<((?:https?|mailto):[^\s>]+)>/gi,
    (_match, url: string) => `[${url}](${url})`,
  )

  // Line breaks and horizontal rules.
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')

  // Images become their alt text; nothing is ever fetched.
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)
    return alt?.[1] ? alt[1] : ''
  })

  // Anchors become Markdown links, so the href goes through the same validation.
  text = text.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const inner = label.replace(/<[^>]*>/g, '').trim()
      return inner === '' ? '' : `[${inner}](${href.trim()})`
    },
  )

  // Headings, on their own lines so the block parser sees them.
  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level: string, inner: string) => {
      const content = inner
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      return content === '' ? '\n' : `\n\n${'#'.repeat(Number(level))} ${content}\n\n`
    },
  )

  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) =>
    inner.trim() === '' ? '' : `**${inner.replace(/<[^>]*>/g, '').trim()}**`,
  )
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) =>
    inner.trim() === '' ? '' : `*${inner.replace(/<[^>]*>/g, '').trim()}*`,
  )

  text = text.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
  text = text.replace(/<\/(p|div|ul|ol|table|tr|section|header|blockquote)>/gi, '\n\n')

  // Anything left over: drop the tag, keep whatever it wrapped.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '')

  return text.replace(/\n{3,}/g, '\n\n')
}

/** Collects `[ref]: url` definitions and removes them from the body. */
function extractLinkDefinitions(source: string): {
  text: string
  definitions: Map<string, string>
} {
  const definitions = new Map<string, string>()

  const text = source.replace(
    /^[ \t]*\[([^\]]+)\]:[ \t]*(\S+).*$/gm,
    (_match, label: string, url: string) => {
      definitions.set(label.toLowerCase(), url)
      return ''
    },
  )

  return { text, definitions }
}

/* ------------------------------------------------------------------ *
 * Phase 2 — inline rendering
 * ------------------------------------------------------------------ */

function renderInline(escaped: string, sentinel: string, definitions: Map<string, string>): string {
  let output = escaped

  // Code spans come out first so their contents are never read as emphasis, a link,
  // or a URL. The sentinel is random per render, so a readme cannot forge one.
  const codeSpans: string[] = []
  output = output.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `${sentinel}C${codeSpans.length - 1}C${sentinel}`
  })

  const link = (label: string, href: string): string => {
    const safe = safeHref(href.replace(/&amp;/g, '&'))
    if (safe === null) return label
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  }

  // Images first, so their alt text is not mistaken for a link label.
  output = output.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => alt)
  output = output.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_match, alt: string) => alt)

  // Inline links.
  output = output.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    (_match, label: string, href: string) => link(label, href),
  )

  // Reference links: [text][ref] and the shortcut form [ref].
  output = output.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, label: string, ref: string) => {
    const target = definitions.get((ref === '' ? label : ref).toLowerCase())
    return target === undefined ? match : link(label, target)
  })
  output = output.replace(/\[([^\]]+)\]/g, (match, label: string) => {
    const target = definitions.get(label.toLowerCase())
    return target === undefined ? match : link(label, target)
  })

  // Explicit autolinks, then bare URLs that are not already inside an href.
  output = output.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_match, url: string) =>
    link(escapeHtml(url), url),
  )
  output = output.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"')\]]+)/g,
    (match, lead: string, url: string) =>
      output.includes(`href="${url}`) ? match : `${lead}${link(escapeHtml(url), url)}`,
  )

  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  output = output.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return output.replace(
    new RegExp(`${sentinel}C(\\d+)C${sentinel}`, 'g'),
    (_match, index: string) => codeSpans[Number(index)] ?? '',
  )
}

/* ------------------------------------------------------------------ *
 * Phase 3 — block rendering
 * ------------------------------------------------------------------ */

interface ListLevel {
  type: 'ul' | 'ol'
  indent: number
}

export function renderMarkdown(source: string): string {
  if (source.trim() === '') return ''

  // Random per render, so nothing in a readme can forge a placeholder.
  const sentinel = `MDX${Math.random().toString(36).slice(2, 12)}X`

  const protectedCode = protectCode(source, sentinel)
  const translated = htmlToMarkdown(protectedCode.text)
  const restored = restoreCode(translated, protectedCode.blocks, sentinel)
  const { text, definitions } = extractLinkDefinitions(restored)

  const lines = escapeHtml(text).split(/\r?\n/)
  const output: string[] = []

  let inCodeBlock = false
  let paragraph: string[] = []
  const listStack: ListLevel[] = []

  const inline = (value: string): string => renderInline(value, sentinel, definitions)

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    output.push(`<p>${inline(paragraph.join(' '))}</p>`)
    paragraph = []
  }

  const closeListsTo = (indent: number): void => {
    while (listStack.length > 0 && (listStack.at(-1) as ListLevel).indent >= indent) {
      output.push(`</${(listStack.pop() as ListLevel).type}>`)
    }
  }

  const closeAllLists = (): void => {
    while (listStack.length > 0) output.push(`</${(listStack.pop() as ListLevel).type}>`)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    if (/^\s*```/.test(line)) {
      flushParagraph()
      closeAllLists()
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
      closeAllLists()
      continue
    }

    // GFM table: a header row followed by a delimiter row.
    const next = lines[index + 1] ?? ''
    if (line.includes('|') && /^[\s|:-]+$/.test(next) && next.includes('-') && next.includes('|')) {
      flushParagraph()
      closeAllLists()
      index = renderTable(lines, index, output, inline)
      continue
    }

    const atx = /^(#{1,6})\s+(.*?)#*\s*$/.exec(line)
    if (atx?.[1] !== undefined && atx[2] !== undefined) {
      flushParagraph()
      closeAllLists()
      // Capped at h4 so a readme cannot outrank the drawer's own heading.
      output.push(
        `<h${Math.min(atx[1].length + 1, 4)}>${inline(atx[2])}</h${Math.min(atx[1].length + 1, 4)}>`,
      )
      continue
    }

    // Setext heading: text underlined with === or ---.
    if (paragraph.length > 0 && /^\s*(={3,}|-{3,})\s*$/.test(line)) {
      const level = line.trim().startsWith('=') ? 2 : 3
      output.push(`<h${level}>${inline(paragraph.join(' '))}</h${level}>`)
      paragraph = []
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flushParagraph()
      closeAllLists()
      output.push('<hr />')
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line)
    const item = bullet ?? numbered

    if (item?.[1] !== undefined && item[2] !== undefined) {
      flushParagraph()
      const indent = item[1].length
      const type: 'ul' | 'ol' = bullet === null ? 'ol' : 'ul'

      closeListsTo(indent + 1)
      const top = listStack.at(-1)
      if (top === undefined || top.indent < indent) {
        output.push(`<${type}>`)
        listStack.push({ type, indent })
      }

      // Task list checkboxes render as glyphs; a real input would imply it is editable.
      const content = item[2].replace(/^\[ \]\s+/, '☐ ').replace(/^\[[xX]\]\s+/, '☑ ')

      output.push(`<li>${inline(content)}</li>`)
      continue
    }

    const quote = /^\s*&gt;\s?(.*)$/.exec(line)
    if (quote?.[1] !== undefined) {
      flushParagraph()
      closeAllLists()
      output.push(`<blockquote>${inline(quote[1])}</blockquote>`)
      continue
    }

    paragraph.push(line.trim())
  }

  flushParagraph()
  closeAllLists()
  if (inCodeBlock) output.push('</code></pre>')

  return output.join('\n')
}

/** Renders a GFM table starting at `start`; returns the last line index consumed. */
function renderTable(
  lines: readonly string[],
  start: number,
  output: string[],
  inline: (value: string) => string,
): number {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  const header = cells(lines[start] ?? '')
  output.push('<table><thead><tr>')
  for (const cell of header) output.push(`<th>${inline(cell)}</th>`)
  output.push('</tr></thead><tbody>')

  let index = start + 2
  for (; index < lines.length; index += 1) {
    const row = lines[index] ?? ''
    if (row.trim() === '' || !row.includes('|')) break

    output.push('<tr>')
    const values = cells(row)
    // Pad or trim to the header width so a ragged row cannot break the layout.
    for (let column = 0; column < header.length; column += 1) {
      output.push(`<td>${inline(values[column] ?? '')}</td>`)
    }
    output.push('</tr>')
  }

  output.push('</tbody></table>')
  return index - 1
}
