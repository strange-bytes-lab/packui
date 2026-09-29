import { findWorkspace, type Workspace } from './workspace.ts'

/**
 * Where a project's shared state lives. For a standalone project that is the project
 * itself. For a workspace package it is the workspace root: the lockfile, the hoisted
 * node_modules, the package manager's own configuration and the mutation lock all
 * belong to the root, while the manifest belongs to the package.
 */
export interface ProjectContext {
  path: string
  /** The directory holding the lockfile. */
  root: string
  /** The project's key in a workspace lockfile: its POSIX path from the root, or `.`. */
  importer: string
  workspace: Workspace | null
}

export async function projectContext(path: string): Promise<ProjectContext> {
  const workspace = await findWorkspace(path)
  const member = workspace?.packages.find((candidate) => candidate.path === path)
  if (workspace === null || member === undefined) {
    return { path, root: path, importer: '.', workspace: null }
  }
  return { path, root: workspace.root, importer: member.relative, workspace }
}
