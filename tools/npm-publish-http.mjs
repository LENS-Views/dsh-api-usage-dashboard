/**
 * Publish through the npm registry HTTP API directly.
 *
 * Two constraints drove this:
 *  - pnpm refuses to publish with an OTP in a non-interactive shell
 *    (ERR_PNPM_OTP_NON_INTERACTIVE) even when --otp is passed.
 *  - the sandbox denies pipes, so Node's spawnSync(stdio: 'pipe') fails with
 *    EPERM; packing therefore happens in-process (tar + gzip), no child process.
 *
 *   node tools/npm-publish-http.mjs              # no OTP (needs a 2FA-bypass token)
 *   node tools/npm-publish-http.mjs --otp 123456
 *   node tools/npm-publish-http.mjs --dry-run
 *
 * Token sources: NPM_TOKEN env var, D:\DSH\.npm-token
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOLS_DIR, '..')
const SECRETS_DIR = path.resolve(REPO_ROOT, '..', '.secrets')
const DEFAULT_TOKEN_FILE = path.join(SECRETS_DIR, 'npm-token')

const REGISTRY = 'https://registry.npmjs.org'
const OUT = path.join(REPO_ROOT, '.npm-out')
const DIR = REPO_ROOT

/** Everything npm would put in the tarball: `files` plus the always-included trio. */
const PACKED_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
  'LICENSE',
]

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

/** Build a gzipped npm-style tarball (entries under `package/`). */
function packTarball(dir) {
  const mtime = Math.floor(Date.now() / 1000)
  const chunks = []
  for (const relative of PACKED_FILES) {
    const content = fs.readFileSync(path.join(dir, relative))
    chunks.push(tarHeader('package/' + relative, content.length, mtime))
    chunks.push(content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 })
}

const dryRun = process.argv.includes('--dry-run')
const otp = arg('--otp')
const dir = arg('--dir', DIR)

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
console.log('package:', manifest.name + '@' + manifest.version)

const tarball = packTarball(dir)
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, `${manifest.name}-${manifest.version}.tgz`), tarball)

const shasum = crypto.createHash('sha1').update(tarball).digest('hex')
const integrity = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64')
console.log('tarball:', tarball.length, 'bytes | files', PACKED_FILES.length, '| shasum', shasum.slice(0, 12) + '…')

const versionManifest = {
  ...manifest,
  _id: `${manifest.name}@${manifest.version}`,
  dist: {
    shasum,
    integrity,
    tarball: `${REGISTRY}/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`,
  },
}

const document = {
  _id: manifest.name,
  name: manifest.name,
  description: manifest.description,
  'dist-tags': { latest: manifest.version },
  versions: { [manifest.version]: versionManifest },
  access: 'public',
  _attachments: {
    [`${manifest.name}-${manifest.version}.tgz`]: {
      content_type: 'application/octet-stream',
      data: tarball.toString('base64'),
      length: tarball.length,
    },
  },
}

const body = JSON.stringify(document)
console.log('publish document:', body.length, 'bytes')

if (dryRun) {
  console.log('dry-run: tarball written to', path.join(OUT, `${manifest.name}-${manifest.version}.tgz`))
  process.exit(0)
}

const token = (process.env.NPM_TOKEN ?? '').trim()
  || (() => {
    try {
      return fs.readFileSync(DEFAULT_TOKEN_FILE, 'utf8').trim()
    } catch {
      return ''
    }
  })()
if (token === '') {
  console.error('no token: set NPM_TOKEN or write', DEFAULT_TOKEN_FILE)
  process.exit(3)
}
console.log('token:', 'loaded (value never printed)')

const headers = {
  authorization: 'Bearer ' + token,
  'content-type': 'application/json',
  'npm-command': 'publish',
  'user-agent': 'dsh-api-usage-dashboard-publish',
}
if (otp !== null) headers['npm-otp'] = otp

const response = await fetch(`${REGISTRY}/${manifest.name}`, {
  method: 'PUT',
  headers,
  body,
  signal: AbortSignal.timeout(120000),
})
const text = await response.text()
console.log('registry:', response.status)
if (response.ok) {
  console.log('published:', manifest.name + '@' + manifest.version)
} else {
  console.error('failed:', text.slice(0, 600))
}
process.exit(response.ok ? 0 : 1)
