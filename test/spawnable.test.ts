import { describe, expect, it } from 'vitest'
import { findOnPath, toInvocation } from '../src/server/core/spawnable.ts'

/**
 * Windows cannot be run here, so the Windows route is tested by injecting the
 * platform and the PATH lookup. What matters is the shape of what reaches spawn, and
 * that nothing cmd.exe would interpret ever gets that far.
 */
const shim = (path: string) => () => path

describe('invocation', () => {
  it('passes commands straight through on POSIX', () => {
    expect(toInvocation('pnpm', ['add', 'vue@3.5.13'], 'linux')).toEqual({
      file: 'pnpm',
      args: ['add', 'vue@3.5.13'],
    })
  })

  it('spawns a Windows .exe directly, with no shell', () => {
    expect(toInvocation('bun', ['add', 'vue@3.5.13'], 'win32', shim('C:\\bun\\bun.exe'))).toEqual({
      file: 'C:\\bun\\bun.exe',
      args: ['add', 'vue@3.5.13'],
    })
  })

  it('runs a .cmd shim through cmd.exe with every argument quoted', () => {
    const invocation = toInvocation(
      'npm',
      ['install', '@scope/pkg@1.2.3', '--save-dev', '--workspace=packages/app'],
      'win32',
      shim('C:\\Program Files (x86)\\nodejs\\npm.cmd'),
      { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    )
    expect(invocation).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files (x86)\\nodejs\\npm.cmd" "install" "@scope/pkg@1.2.3" "--save-dev" "--workspace=packages/app""',
      ],
      windowsVerbatimArguments: true,
    })
  })

  it.each(['a&calc', 'x|y', '%PATH%', '!x!', 'a^b', 'two words', '"quoted"', '(x)', 'a<b', 'a>b'])(
    'refuses to hand %s to cmd.exe',
    (arg) => {
      expect(() => toInvocation('npm', ['install', arg], 'win32', shim('C:\\n\\npm.cmd'))).toThrow(
        /Refusing/,
      )
    },
  )

  it('refuses a shim path cmd.exe would interpret', () => {
    expect(() => toInvocation('npm', ['install'], 'win32', shim('C:\\a&b\\npm.cmd'))).toThrow(
      /Refusing/,
    )
  })

  it('leaves an unknown command for spawn to report as not installed', () => {
    expect(toInvocation('nope', ['x'], 'win32', () => null)).toEqual({ file: 'nope', args: ['x'] })
  })
})

describe('Windows PATH lookup', () => {
  it('tries PATHEXT extensions in order, directory by directory', () => {
    const present = new Set(['C:\\b\\npm.cmd', 'C:\\c\\npm.exe'])
    const found = findOnPath('npm', { PATH: 'C:\\a;C:\\b;C:\\c', PATHEXT: '.EXE;.CMD' }, (path) =>
      present.has(path.replaceAll('/', '\\')),
    )
    expect(found?.replaceAll('/', '\\')).toBe('C:\\b\\npm.cmd')
  })
})
