import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import test from 'node:test'
import { uploadImages } from '../../src/main/images.ts'

async function tempUploadDirs() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('m-typora-upload-'))
}

test('uploadImages creates distinct temp files for in-memory uploads and cleans up on success and failure', async () => {
  const before = new Set(await tempUploadDirs())
  const seenPaths = []
  let failMode = false

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const list = JSON.parse(body || '{}').list ?? []
      seenPaths.push(...list)
      res.setHeader('Content-Type', 'application/json')
      if (failMode) {
        res.end(JSON.stringify({ success: false, message: 'boom' }))
      } else {
        res.end(JSON.stringify({ success: true, result: list.map((p) => `https://cdn.example/${basename(p)}`) }))
      }
    })
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

  try {
    const config = { service: 'picgo-app', picgoPort: port, picgoPath: '', command: '' }
    const files = [
      { name: 'shot.png', data: Uint8Array.from([1, 2]).buffer },
      { name: 'shot.png', data: Uint8Array.from([3, 4]).buffer }
    ]
    const urls = await uploadImages(files, config)
    assert.equal(urls.length, 2)
    assert.equal(new Set(seenPaths).size, 2)

    const afterSuccess = (await tempUploadDirs()).filter((d) => !before.has(d))
    assert.deepEqual(afterSuccess, [])

    failMode = true
    await assert.rejects(() => uploadImages(files, config), /boom/)
    const afterFailure = (await tempUploadDirs()).filter((d) => !before.has(d))
    assert.deepEqual(afterFailure, [])
  } finally {
    server.close()
  }
})
