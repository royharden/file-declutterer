const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const PROPOSAL_FILE_CAP = 80

export function assertWorkspaceOnlyBody(
  body: unknown,
): { ok: true; workspaceId: string } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Body must be a JSON object.' }
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'workspace_id') {
    return {
      ok: false,
      message: 'Send only workspace_id. This function loads paths itself and does not accept file contents.',
    }
  }
  const workspaceId = record.workspace_id
  if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
    return { ok: false, message: 'workspace_id must be a UUID.' }
  }
  return { ok: true, workspaceId }
}
