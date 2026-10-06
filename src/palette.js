// A fixed 216-color RGB cube plus 40 additional neutral shades.
// Keep this lookup stable: version 2 share links store indices into it.
const rgb = []
for (let red = 0; red < 6; red++) {
  for (let green = 0; green < 6; green++) {
    for (let blue = 0; blue < 6; blue++) rgb.push([red * 51, green * 51, blue * 51])
  }
}
for (let i = 1; i <= 40; i++) {
  const gray = Math.round(i * 255 / 41)
  rgb.push([gray, gray, gray])
}

export const PALETTE = Object.freeze(rgb.map(color => `#${color.map(value => value.toString(16).padStart(2, '0')).join('')}`))
const indices = new Map(PALETTE.map((color, index) => [color, index]))

export function paletteIndex(color) {
  const cached = indices.get(color)
  if (cached !== undefined) return cached
  const value = parseInt(color.slice(1), 16)
  const red = value >> 16, green = (value >> 8) & 255, blue = value & 255
  let closest = 0, bestDistance = Infinity
  for (let index = 0; index < rgb.length; index++) {
    const candidate = rgb[index]
    const meanRed = (red + candidate[0]) / 2
    const distance = (2 + meanRed / 256) * (red - candidate[0]) ** 2
      + 4 * (green - candidate[1]) ** 2
      + (2 + (255 - meanRed) / 256) * (blue - candidate[2]) ** 2
    if (distance < bestDistance) { bestDistance = distance; closest = index }
  }
  indices.set(color, closest)
  return closest
}

export function quantizeSamples(samples) {
  return samples.map(color => PALETTE[paletteIndex(color)])
}
