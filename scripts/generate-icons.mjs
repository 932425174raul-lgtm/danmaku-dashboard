import { readFile, writeFile } from 'node:fs/promises'

import png2icons from 'png2icons'

const source = await readFile(new URL('../assets/icon-source.png', import.meta.url))
const icns = png2icons.createICNS(source, png2icons.BICUBIC, 0)
const ico = png2icons.createICO(source, png2icons.BICUBIC, 0, false, true)

if (icns === null) throw new Error('ICNS_GENERATION_FAILED')
if (ico === null) throw new Error('ICO_GENERATION_FAILED')

await Promise.all([
  writeFile(new URL('../assets/icon.icns', import.meta.url), icns),
  writeFile(new URL('../assets/icon.ico', import.meta.url), ico),
])
