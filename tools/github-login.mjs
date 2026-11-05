/**
 * GitHub OAuth device-flow login (the mechanism `gh auth login` and Codex use).
 *
 *   node tools/github-login.mjs --client-id <CLIENT_ID> [--scopes repo] [--token-file <path>]
 *
 * Prints a one-time code and the verification URL, then polls until the user
 * approves it in the browser. On success the access token is written to the
 * token file (default D:\DSH\.github-token) and is NEVER printed.
 *
 * The OAuth App must have "Enable Device Flow" ticked in its settings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_TOKEN_FILE = path.resolve(REPO_ROOT, '..', '.secrets', 'github-token')

function parseArgs(argv) {
  const out = { clientId: null, scopes: 'repo', tokenFile: DEFAULT_TOKEN_FILE }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--client-id') out.clientId = argv[++i]
    else if (arg === '--scopes') out.scopes = argv[++i]
    else if (arg === '--token-file') out.tokenFile = argv[++i]
    else throw new Error('unknown argument: ' + arg)
  }
  if (out.clientId === null) throw new Error('--client-id is required')
  return out
}

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'dsh-api-usage-dashboard-login',
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }
  return { status: response.status, payload }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const options = parseArgs(process.argv)
const started = await postForm(DEVICE_CODE_URL, {
  client_id: options.clientId,
  scope: options.scopes,
})
const start = started.payload
if (started.status !== 200 || !start.device_code) {
  console.error('device-code request failed:', started.status, JSON.stringify(start))
  process.exit(2)
}

console.log('open this page:', start.verification_uri)
if (start.verification_uri_complete) console.log('or use this link:', start.verification_uri_complete)
console.log('enter this code:', start.user_code)
console.log('waiting for authorization…')

let intervalMs = Math.max(5, Number(start.interval) || 5) * 1000
const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000

for (;;) {
  if (Date.now() > deadline) {
    console.error('device code expired, run the login again')
    process.exit(3)
  }
  await sleep(intervalMs)
  const poll = await postForm(TOKEN_URL, {
    client_id: options.clientId,
    device_code: start.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  const body = poll.payload
  if (body.access_token) {
    fs.writeFileSync(options.tokenFile, body.access_token + '\n', { mode: 0o600 })
    console.log('authorized; token written to', options.tokenFile)
    console.log('scopes:', body.scope ?? options.scopes, '| type:', body.token_type ?? 'bearer')
    console.log('the token is not printed anywhere')
    process.exit(0)
  }
  if (body.error === 'authorization_pending') continue
  if (body.error === 'slow_down') {
    intervalMs += 5000
    continue
  }
  console.error('authorization failed:', body.error ?? poll.status, body.error_description ?? '')
  process.exit(4)
}
