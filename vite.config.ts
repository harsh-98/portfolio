import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/portfolio/',
  plugins: [react(), {
    name: 'northstar-app-shell',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => /\.(?:js|css)$/.test(name)).sort()
      const files = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', ...assets]
      const template = readFileSync(new URL('./scripts/service-worker.template.js', import.meta.url), 'utf8')
      const version = createHash('sha256').update(JSON.stringify(files) + template + readFileSync(new URL('./index.html', import.meta.url), 'utf8') + readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8')).digest('hex').slice(0, 12)
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__CACHE_VERSION__', `northstar-shell-${version}`).replace('__SHELL_FILES__', JSON.stringify(files)) })
    },
  }],
})
