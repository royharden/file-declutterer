import { createClient } from 'npm:@supabase/supabase-js@2.49.8'
import { selectablePaths } from './pathSafety.ts'
import { assertWorkspaceOnlyBody, PROPOSAL_FILE_CAP } from './proposalGuard.ts'
import { acceptProposals, extractJsonObject, messageText } from './proposals.ts'

const MODEL = 'grok-4.7'
const ENDPOINT = 'https://api.x.ai/v1/chat/completions'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SYSTEM_PROMPT = [
  'You propose file moves. You receive only relative file paths. You do not receive file contents, and you must not ask for them.',
  'Return a JSON object with one key, proposals. Each item has only "from" and "to".',
  '"from" must be copied exactly from the input.',
  '"to" is a relative path: one category folder, a slash, then a filename.',
  'Use only these folders: Documents, Photos, Audio, Video, Archives, Code, Misc.',
  'Keep the same extension. A file with no extension still has no extension.',
  'Do not use "..", absolute paths, drive letters, or Windows reserved names such as CON, PRN, AUX, NUL, COM1, or LPT1.',
  'Do not add explanations or any other keys.',
].join(' ')

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function redact(text: string, secret: string): string {
  const clipped = text.length > 300 ? text.slice(0, 300) : text
  return secret ? clipped.split(secret).join('[redacted]') : clipped
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) {
    return json(500, { error: 'SUPABASE_URL or SUPABASE_ANON_KEY is not available to this function.' })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'Body must be JSON.' })
  }
  const gate = assertWorkspaceOnlyBody(body)
  if (!gate.ok) return json(400, { error: gate.message })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json(401, { error: 'Sign in is required.' })
  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) return json(401, { error: 'Sign in is required.' })

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser(token)
  if (userError || !userData.user) return json(401, { error: 'The session is not valid. Sign in again.' })

  const apiKey = Deno.env.get('XAI_API_KEY')
  if (!apiKey) {
    return json(503, {
      error: 'XAI_API_KEY is not configured. Add it in server secrets. Rules mode still works without it.',
    })
  }

  const { data: workspace, error: workspaceError } = await userClient
    .from('workspaces')
    .select('id')
    .eq('id', gate.workspaceId)
    .maybeSingle()
  if (workspaceError) return json(500, { error: 'Could not read the workspace.' })
  if (!workspace) return json(404, { error: 'Workspace not found.' })

  const { data: rows, error: nodeError } = await userClient
    .from('file_nodes')
    .select('rel_path, kind')
    .eq('workspace_id', gate.workspaceId)
  if (nodeError) return json(500, { error: 'Could not read file paths.' })

  const eligible = selectablePaths(rows ?? [])
  if (eligible.length === 0) {
    return json(200, {
      model: null,
      proposals: [],
      rejected: [],
      credit_used: false,
      note: 'No eligible files. Protected files and system folders are not sent.',
    })
  }
  if (eligible.length > PROPOSAL_FILE_CAP) {
    return json(400, {
      error: `This workspace has ${eligible.length} eligible files. The AI proposer accepts at most ${PROPOSAL_FILE_CAP}. Use rules mode, or organize a smaller workspace.`,
    })
  }

  const { error: creditError } = await userClient.rpc('consume_proposal_credit')
  if (creditError) {
    const message = creditError.message ?? ''
    if (message.includes('daily proposal limit')) {
      return json(429, { error: 'Daily AI proposal limit reached (20 per UTC day).' })
    }
    if (message.includes('not authenticated')) return json(401, { error: 'Sign in is required.' })
    return json(500, { error: 'Could not record the proposal attempt.' })
  }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ paths: eligible }) },
        ],
      }),
    })
  } catch {
    return json(502, { error: 'The model request did not finish.', credit_used: true })
  }

  if (!response.ok) {
    const detail = redact(await response.text(), apiKey)
    return json(502, {
      error: 'The model request failed.',
      credit_used: true,
      status: response.status,
      detail,
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return json(502, { error: 'The model returned invalid JSON.', credit_used: true })
  }

  const content =
    payload &&
    typeof payload === 'object' &&
    'choices' in payload &&
    Array.isArray(payload.choices)
      ? messageText(
          (payload.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content,
        )
      : ''
  if (!content) return json(502, { error: 'The model returned an empty proposal.', credit_used: true })

  let parsed: unknown
  try {
    parsed = extractJsonObject(content)
  } catch {
    return json(422, { error: 'The model did not return a JSON object.', credit_used: true })
  }

  const accepted = acceptProposals(eligible, parsed)
  if (accepted.contractError) {
    return json(422, { error: accepted.contractError, credit_used: true, model: MODEL })
  }
  return json(200, {
    model: MODEL,
    proposals: accepted.proposals,
    rejected: accepted.rejected,
    credit_used: true,
  })
})
