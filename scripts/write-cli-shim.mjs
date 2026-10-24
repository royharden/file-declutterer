// Writes dist-cli/main.js, the package bin, as a thin ESM entry that loads the compiled CLI.
// tsc emits cli/main.ts to dist-cli/cli/main.js because rootDir covers src/core and cli.
import { writeFileSync, chmodSync } from 'node:fs'

const target = new URL('../dist-cli/main.js', import.meta.url)
writeFileSync(target, "#!/usr/bin/env node\nimport './cli/main.js'\n", 'utf8')
try {
  chmodSync(target, 0o755)
} catch {
  // chmod is a no-op on some Windows file systems.
}
