/** Plain-text tree view. Names are rendered as React text nodes, never as HTML. */
export function describeTree(paths: { path: string; kind: 'file' | 'dir' }[]): string {
  return paths
    .map((entry) => {
      const depth = entry.path.split('/').length - 1
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      return `${'  '.repeat(depth)}${name}${entry.kind === 'dir' ? '/' : ''}`
    })
    .join('\n')
}

/** Predicted tree after applying moves: files relocate, new parent folders appear. */
export function predictTree(
  paths: { path: string; kind: 'file' | 'dir' }[],
  moves: { from: string; to: string }[],
): { path: string; kind: 'file' | 'dir' }[] {
  const moved = new Map(moves.map((m) => [m.from, m.to]))
  const out = new Map<string, 'file' | 'dir'>()
  for (const entry of paths) {
    if (entry.kind === 'file' && moved.has(entry.path)) continue
    out.set(entry.path, entry.kind)
  }
  for (const move of moves) {
    const parts = move.to.split('/')
    let acc = ''
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]!
      if (!out.has(acc)) out.set(acc, 'dir')
    }
    out.set(move.to, 'file')
  }
  return [...out.entries()]
    .map(([path, kind]) => ({ path, kind }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
