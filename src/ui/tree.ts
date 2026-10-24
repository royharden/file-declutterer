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
