import { readFile, writeFile } from 'node:fs/promises'

import png2icons from 'png2icons'

const source = await readFile(new URL('../assets/icon-source.png', import.meta.url))
const icon = png2icons.createICNS(source, png2icons.BICUBIC, 0)

if (icon === null) {
  throw new Error('ICNS_GENERATION_FAILED')
}

await writeFile(new URL('../assets/icon.icns', import.meta.url), icon)
