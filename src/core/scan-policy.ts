import { compareKey } from './paths.js'
import type { ScanBounds, SkipReason } from './types.js'

export const POLICY_ID = 'scan-policy-v1'

export const DEFAULT_BOUNDS: ScanBounds = {
  maxFiles: 500,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxDepth: 4,
  maxEntries: 2000,
}

/** Reserved namespaces owned by the app inside the selected root. */
export interface RootConfig {
  outputRoot: string
  quarantineRoot: string
}

export const DEFAULT_ROOT_CONFIG: RootConfig = {
  outputRoot: '_Organized',
  quarantineRoot: '_declutter-quarantine',
}

const PROJECT_MARKER_NAMES = new Set(['.git', 'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod'])

/** True when a directory listing marks the directory as a project root. */
export function isProjectMarker(name: string): boolean {
  const lower = name.toLowerCase()
  return PROJECT_MARKER_NAMES.has(lower) || lower.endsWith('.sln')
}

const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules'])
const LOCK_AND_PACKAGE = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'cargo.lock',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
  'go.sum',
])
const APP_STATE = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'icon\r'])
const CREDENTIAL_NAME = /^(\.env(\..*)?|.*\.(pem|key|pfx|p12|kdbx|keystore|jks|ovpn)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials?(\..*)?|secrets?(\..*)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd)$/i
const NOTICE_NAME = /^(readme|license|licence|copying|notice|authors)([._-].*)?$/i

/**
 * Why a file must not be organized, or null if it is eligible. Applied symmetrically to
 * sources and destinations. Credential contents are never read; only names are checked.
 */
export function protectionReason(
  relPath: string,
  config: RootConfig = DEFAULT_ROOT_CONFIG,
  allowReserved: 'none' | 'output' | 'quarantine' = 'none',
): SkipReason | null {
  const parts = relPath.split('/')
  const top = compareKey(parts[0] ?? '')
  if (top === compareKey(config.quarantineRoot) && allowReserved !== 'quarantine') return 'quarantine-root'
  if (top === compareKey(config.outputRoot) && allowReserved !== 'output') return 'output-root'
  for (const part of parts) {
    if (PROTECTED_SEGMENTS.has(part.toLowerCase())) return 'protected'
  }
  const base = parts[parts.length - 1] ?? ''
  const lower = base.toLowerCase()
  if (APP_STATE.has(lower)) return 'app-state'
  if (CREDENTIAL_NAME.test(base)) return 'protected'
  if (LOCK_AND_PACKAGE.has(lower)) return 'protected'
  if (NOTICE_NAME.test(base)) return 'protected'
  if (parts.some((part) => part.startsWith('.'))) return 'hidden'
  return null
}

/**
 * Destinations get the same name protection as sources. Only the plan kind that owns a
 * reserved namespace may write into it: organize -> output root, quarantine -> quarantine root.
 * Restore returns files to their original paths, which may be ordinary or under the output root
 * (duplicates are scanned there), never into quarantine.
 */
export function destinationProtection(
  relPath: string,
  kind: 'organize' | 'quarantine' | 'restore',
  config: RootConfig = DEFAULT_ROOT_CONFIG,
): SkipReason | null {
  const allow = kind === 'quarantine' ? 'quarantine' : 'output'
  return protectionReason(relPath, config, allow)
}

export function isUnder(relPath: string, root: string): boolean {
  const key = compareKey(relPath)
  const rootKey = compareKey(root)
  return key === rootKey || key.startsWith(`${rootKey}/`)
}
