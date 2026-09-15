import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Reads a package's README from node_modules.
 *
 * registry.npmjs.org no longer serves README content: the `readme` field on the
 * full packument comes back as an empty string, and the per-version documents
 * (`/<pkg>/latest`, `/<pkg>/<version>`) do not carry one at all. Verified against
 * both minimist and vue.
 *
 * Reading from the installed package is better than the registry would have been
 * even if it worked. The tarball already contains the README, it is the README for
 * the version actually installed rather than for latest, it needs no network, and
 * it introduces no trust beyond code that is already sitting in the project.
 *
 * Packages that are declared but not installed simply have no README to show.
 */

/** Matched case-insensitively; packages are inconsistent about this. */
const README_PATTERN = /^readme(\.(md|markdown|mdown|txt|rst))?$/i

/** A README is rendered in a drawer, so an enormous one is a rendering hazard. */
const MAX_BYTES = 512 * 1024

export async function readLocalReadme(
  projectPath: string,
  packageName: string,
): Promise<string | null> {
  const packageDir = join(projectPath, 'node_modules', packageName)

  let entries: string[]
  try {
    entries = await readdir(packageDir)
  } catch {
    return null
  }

  // Prefer a Markdown README when a package ships more than one.
  const candidates = entries
    .filter((entry) => README_PATTERN.test(entry))
    .sort((a, b) => Number(b.toLowerCase().endsWith('.md')) - Number(a.toLowerCase().endsWith('.md')))

  const chosen = candidates[0]
  if (chosen === undefined) return null

  try {
    const contents = await readFile(join(packageDir, chosen), 'utf8')
    return contents.length > MAX_BYTES
      ? `${contents.slice(0, MAX_BYTES)}\n\n_(README truncated by packui.)_`
      : contents
  } catch {
    return null
  }
}
