import { PALETTE, paletteIndex } from './palette.js'

const GRID = 32
const PIXEL_COUNT = GRID * GRID

export const SIMULATION_DEFAULTS = {
  lift: 2.2, releaseInterval: 0.02, maxBalloons: 1000, spawnRadius: 1.75,
  spawnHeight: 0.2, balloonSize: 0.06, friction: 0.15,
}

export function readShareParams(search) {
  const params = new URLSearchParams(search)
  const image = params.get('image')
  if (!image) return null
  const seed = Number(params.get('seed'))
  if (!params.has('seed') || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('This share link has an invalid seed.')
  return { image, seed }
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function encodeSamples(samples) {
  if (samples.length !== GRID * GRID) throw new Error('The image is not ready to share.')
  const bytes = Uint8Array.from(samples, paletteIndex)
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
    if (compressed.length < bytes.length) return `2d.${toBase64(compressed)}`
  }
  return `2r.${toBase64(bytes)}`
}

export async function decodeSamples(payload) {
  if (payload.length > 5000 || !/^[12][dr]\.[A-Za-z0-9_-]+$/.test(payload)) throw new Error('This share link has invalid image data.')
  const indexed = payload[0] === '2'
  const byteCount = PIXEL_COUNT * (indexed ? 1 : 3)
  let bytes = Uint8Array.from(atob(payload.slice(3).replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))
  if (payload[1] === 'd') {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
    const chunks = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > byteCount) { await reader.cancel(); throw new Error('This share link has invalid image data.') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  }
  if (bytes.length !== byteCount) throw new Error('This share link has invalid image data.')
  if (indexed) return Array.from(bytes, index => PALETTE[index])
  return Array.from({ length: GRID * GRID }, (_, i) => `#${Array.from(bytes.slice(i * 3, i * 3 + 3), value => value.toString(16).padStart(2, '0')).join('')}`)
}

export function samplesPreview(samples) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = GRID
  const context = canvas.getContext('2d')
  samples.forEach((color, i) => { context.fillStyle = color; context.fillRect(i % GRID, Math.floor(i / GRID), 1, 1) })
  return canvas.toDataURL('image/png')
}
