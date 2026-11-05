/**
 * Publish a directory to GitHub through the REST API (no git binary needed).
 *
 * Auth (never printed, never echoed):
 *   --token-file <path>  a file holding a token (any format, trimmed)
 *   GITHUB_TOKEN env var
 *   D:\DSH\.github-token (default)
 *
 * Usage:
 *   node tools/github-publish.mjs --repo dsh-api-usage-dashboard --dir D:\DSH\dsh-api-usage-dashboard
 *   node tools/github-publish.mjs ... --dry-run      # no network, just show the payload
 *   node tools/github-publish.mjs ... --private
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root = one level above tools/; secrets live beside the repo. */
const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOLS_DIR, '..')
const DEFAULT_TOKEN_FILE = path.resolve(REPO_ROOT, '..', '.secrets', 'github-token')

const FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
  'LICENSE',
  '.gitignore',
  'docs/screenshot.png',
  'tools/github-login.mjs',
  'tools/github-publish.mjs',
  'tools/npm-publish-http.mjs',
]

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tgz)$/i

const API = 'https://api.github.com'

function parseArgs(argv) {
  const out = { repo: 'dsh-api-usage-dashboard', dir: REPO_ROOT, private: false, dryRun: false, tokenFile: null, message: 'feat: DSH API usage dashboard' }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') out.repo = argv[++i]
    else if (arg === '--dir') out.dir = argv[++i]
    else if (arg === '--token-file') out.tokenFile = argv[++i]
    else if (arg === '--message') out.message = argv[++i]
    else if (arg === '--private') out.private = true
    else if (arg === '--dry-run') out.dryRun = true
    else throw new Error('unknown argument: ' + arg)
  }
  return out
}

function readToken(options) {
  const candidates = [options.tokenFile, process.env.GITHUB_TOKEN_FILE, process.env.GITHUB_TOKEN, DEFAULT_TOKEN_FILE].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8').trim()
      const token = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#'))
      if (token) return { token, source: candidate }
    } catch {
      /* try the next source */
    }
  }
  return null
}

function collect(dir) {
  const entries = []
  for (const relative of FILES) {
    const absolute = path.join(dir, relative)
    const buffer = fs.readFileSync(absolute)
    const relativePath = relative.replace(/\\/g, '/')
    entries.push({
      path: relativePath,
      buffer,
      binary: BINARY_EXTENSIONS.test(relativePath),
    })
  }
  return entries
}

async function api(token, method, endpoint, body) {
  const response = await fetch(API + endpoint, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'dsh-api-usage-dashboard-publish',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await response.text()
  let payload = null
  try { payload = text === '' ? null : JSON.parse(text) } catch { payload = text }
  return { status: response.status, ok: response.ok, payload }
}

const options = parseArgs(process.argv)
const entries = collect(options.dir)
const totalBytes = entries.reduce((sum, entry) => sum + entry.buffer.length, 0)
console.log(`files: ${entries.length}, bytes: ${totalBytes}`)
for (const entry of entries) {
  console.log(`  ${entry.path} (${entry.buffer.length} B${entry.binary ? ', binary' : ''})`)
}

if (options.dryRun) {
  console.log('dry-run: payload collected, no network call made')
  process.exit(0)
}

const auth = readToken(options)
if (auth === null) {
  console.error('no token: pass --token-file, set GITHUB_TOKEN, or write D:\\DSH\\.github-token')
  process.exit(2)
}
console.log('token source:', auth.source)

const me = await api(auth.token, 'GET', '/user')
if (!me.ok) {
  console.error('auth check failed:', me.status, typeof me.payload === 'object' && me.payload !== null ? me.payload.message : '')
  process.exit(3)
}
const owner = me.payload.login
console.log('authenticated as:', owner)

// Look before creating: a POST on every publish burns the content-creation
// rate limit and can get the account blocked for a while.
let info = await api(auth.token, 'GET', `/repos/${owner}/${options.repo}`)
if (info.status === 404) {
  const created = await api(auth.token, 'POST', '/user/repos', {
    name: options.repo,
    private: options.private,
    description: 'DSH plugin: API usage dashboard panel (24h bar chart, per-day drill-down, per-model breakdown).',
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  })
  if (!created.ok) {
    console.error('repo create failed:', created.status, created.payload && created.payload.message)
    process.exit(4)
  }
  console.log('repo created:', created.payload.full_name)
  info = await api(auth.token, 'GET', `/repos/${owner}/${options.repo}`)
} else if (!info.ok) {
  console.error('repo lookup failed:', info.status, info.payload && info.payload.message)
  process.exit(4)
} else {
  console.log('repo exists, reusing it')
}

const branch = info.ok && info.payload && info.payload.default_branch ? info.payload.default_branch : 'main'

// An empty repository has no commit to hang a tree on (the Git Data API
// answers 409), so seed one throwaway file through the Contents API first.
let ref = await api(auth.token, 'GET', `/repos/${owner}/${options.repo}/git/ref/heads/${branch}`)
if (!ref.ok) {
  const seed = await api(auth.token, 'PUT', `/repos/${owner}/${options.repo}/contents/.init`, {
    message: 'chore: initialize repository',
    content: Buffer.from('init\n').toString('base64'),
  })
  if (!seed.ok) {
    console.error('seed commit failed:', seed.status, seed.payload && seed.payload.message)
    process.exit(8)
  }
  ref = await api(auth.token, 'GET', `/repos/${owner}/${options.repo}/git/ref/heads/${branch}`)
}

// Binary files cannot ride in a tree entry as inline text, so they go through
// the blob API first (base64) and the tree references their sha.
const treeItems = []
for (const entry of entries) {
  if (!entry.binary) {
    treeItems.push({ path: entry.path, mode: '100644', type: 'blob', content: entry.buffer.toString('utf8') })
    continue
  }
  const blob = await api(auth.token, 'POST', `/repos/${owner}/${options.repo}/git/blobs`, {
    content: entry.buffer.toString('base64'),
    encoding: 'base64',
  })
  if (!blob.ok) {
    console.error('blob failed for', entry.path, ':', blob.status, blob.payload && blob.payload.message)
    process.exit(9)
  }
  treeItems.push({ path: entry.path, mode: '100644', type: 'blob', sha: blob.payload.sha })
}

const treeApi = await api(auth.token, 'POST', `/repos/${owner}/${options.repo}/git/trees`, {
  tree: treeItems,
})
if (!treeApi.ok) {
  console.error('tree failed:', treeApi.status, treeApi.payload && treeApi.payload.message)
  process.exit(5)
}

const parents = ref.ok && ref.payload && ref.payload.object ? [ref.payload.object.sha] : []
const commit = await api(auth.token, 'POST', `/repos/${owner}/${options.repo}/git/commits`, {
  message: options.message,
  tree: treeApi.payload.sha,
  parents,
})
if (!commit.ok) {
  console.error('commit failed:', commit.status, commit.payload && commit.payload.message)
  process.exit(6)
}

const updated = ref.ok
  ? await api(auth.token, 'PATCH', `/repos/${owner}/${options.repo}/git/refs/heads/${branch}`, { sha: commit.payload.sha, force: false })
  : await api(auth.token, 'POST', `/repos/${owner}/${options.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.payload.sha })
if (!updated.ok) {
  console.error('ref update failed:', updated.status, updated.payload && updated.payload.message)
  process.exit(7)
}

console.log('branch:', branch, '| commit:', commit.payload.sha)
console.log('pushed:', `https://github.com/${owner}/${options.repo}`)
