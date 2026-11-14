// Build-time generation of THIRD-PARTY-NOTICES.txt: the license texts of every
// package that ships in the app (no Electron dependency at runtime).
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

interface PackageJson {
  name: string
  version: string
  license?: string | { type: string }
  /** the old form, still used by some packages (ssh2): one entry per license offered */
  licenses?: { type: string }[]
  repository?: string | { url: string }
  homepage?: string
  author?: string | { name: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const readPackage = (dir: string): PackageJson => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

/** Root directory of the package a bundled module belongs to, from its path. */
function packageRoot(id: string): string | undefined {
  const at = id.lastIndexOf('/node_modules/')
  if (at < 0 || id.startsWith('\0')) return undefined
  const start = at + '/node_modules/'.length
  const [first, second] = id.slice(start).split('/')
  return id.slice(0, start) + (first.startsWith('@') ? `${first}/${second}` : first)
}

/** Node's resolution of a dependency's directory: `node_modules/<name>` in `from` or one of its ancestors. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) return undefined
  }
}

/** The runtime dependencies electron-builder packs into app.asar (installed optional ones included). */
function runtimePackages(root: string): Set<string> {
  const found = new Set<string>()
  const visit = (dir: string): void => {
    const pkg = readPackage(dir)
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const dep = findPackage(name, dir)
      if (dep && !found.has(dep)) {
        found.add(dep)
        visit(dep)
      }
    }
  }
  visit(root)
  return found
}

const noticeFile = /^(licen[cs]e|copying|notice|third-?party-?notices)/i

function declaredLicense(pkg: PackageJson): string {
  if (typeof pkg.license === 'object') return pkg.license.type
  if (pkg.license) return pkg.license
  if (pkg.licenses?.length) return pkg.licenses.map((l) => l.type).join(' OR ')
  return 'license not declared'
}

/** The "License" section of the README, for packages that put the license text only there (pg-types, pgpass). */
function readmeLicense(dir: string): string | undefined {
  const readme = readdirSync(dir).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f))
  if (!readme) return undefined
  const lines = readFileSync(join(dir, readme), 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{1,6}\s+licen[cs]e\b/i.test(l))
  if (start < 0) return undefined
  const level = lines[start].match(/^#+/)![0].length
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l))
  const text = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
  return text ? `(from the README)\n\n${text}` : undefined
}

function notice(dir: string): string {
  const pkg = readPackage(dir)
  const license = declaredLicense(pkg)
  const repository = typeof pkg.repository === 'object' ? pkg.repository.url : pkg.repository
  const author = typeof pkg.author === 'object' ? pkg.author.name : pkg.author
  const texts = readdirSync(dir)
    .filter((f) => noticeFile.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').trim())
  const header = [`${pkg.name} ${pkg.version} (${license})`, author, repository ?? pkg.homepage].filter(Boolean).join('\n')
  if (!texts.length) texts.push(readmeLicense(dir) ?? '(the package ships no license file)')
  return [header, ...texts].join('\n\n')
}

/**
 * Emits THIRD-PARTY-NOTICES.txt into the renderer output. It lists the packages
 * bundled into the renderer and the runtime dependencies of package.json, which
 * the main process loads from node_modules.
 */
export function thirdPartyNotices(root: string): Plugin {
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = runtimePackages(root)
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const id of chunk.moduleIds) {
          const dir = packageRoot(id)
          if (dir) dirs.add(realpathSync(dir))
        }
      }
      const notices = [...dirs].map(notice).sort((a, b) => a.localeCompare(b))
      const intro = 'DBKnife includes the following third-party software.'
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-NOTICES.txt',
        source: [intro, ...notices].join(`\n\n${'='.repeat(78)}\n\n`) + '\n'
      })
    }
  }
}
