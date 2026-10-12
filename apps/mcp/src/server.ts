// MCP server: the company brain as tools for Claude, ChatGPT or any MCP client.
//
// Every tool runs as one person or role (only what they may open): set CB_AS to a role id
// ("ROLE-SALES") or a person's name ("Priya Shah"); unset = full access (FDE). Questions are rewritten
// into the company's own words and split into parts before searching.
//
// Tools:
//   ask_company          the question, rewritten and searched; the evidence and facts that answer it
//   search / fetch       the shape ChatGPT's company knowledge and deep research expect
//   search_company, get_entity, get_relationships, get_current_facts, get_fact_history, get_timeline,
//   query_business_metrics, open_source   (packages/core/src/answer/tools.ts)
//
// Run:
//   stdio (Claude Desktop, Claude Code):  npx tsx apps/mcp/src/server.ts
//   HTTP (ChatGPT, remote):               npx tsx apps/mcp/src/server.ts --http   → http://localhost:4321/mcp/<CB_MCP_SECRET>
// Over HTTP the path carries a secret (CB_MCP_SECRET, required): anyone with the URL can query as CB_AS.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildContext } from '@companybrain/core/answer/answer'
import { openSource, runTool, searchCompany, TOOL_SPECS, type ToolCtx } from '@companybrain/core/answer/tools'
import { principalFor } from '@companybrain/core/evals/roles'
import { pool, tenantBySlug } from '@companybrain/core/workbench/server'

const SLUG = process.env.CB_TENANT ?? 'riverton'
const PORT = Number(process.env.CB_MCP_PORT ?? 4321)
// Where a source can be opened (ChatGPT only cites results that carry a link).
const SOURCE_URL = process.env.CB_SOURCE_URL ?? `http://localhost:4320/${SLUG}/sources`

// Logs go to stderr: on stdio, stdout is the protocol.
const log = (...a: unknown[]) => console.error('[mcp]', ...a)

async function context(): Promise<ToolCtx & { who: string }> {
  const sql = pool()
  const t = await tenantBySlug(SLUG)
  if (!t) throw new Error(`unknown tenant ${SLUG}`)
  const asked = process.env.CB_AS?.trim()
  if (!asked) return { sql, tenantId: t.id, as: null, rewrite: true, who: 'full access (FDE)' }
  const who = await principalFor(sql, t.id, SLUG, /^ROLE-/.test(asked) ? { role: asked } : { person: { name: asked } })
  if (!who) throw new Error(`CB_AS: no role or person "${asked}"`)
  return { sql, tenantId: t.id, as: who.id, rewrite: true, who: `${asked} (${who.name})` }
}

const ASK = {
  name: 'ask_company',
  description:
    "Ask a question about the company in plain words (nicknames and jargon are fine). It is rewritten into the company's own terms, split into parts if it asks several things, and searched across documents, email, interviews, video, photos and records. Returns the facts on record (current and past) and numbered sources with where each is from. Start here; then use search_company, get_entity, get_fact_history or open_source to dig further.",
  input_schema: { type: 'object', properties: { question: { type: 'string' }, as_of: { type: 'string', description: 'YYYY-MM-DD: the question is about that date' } }, required: ['question'] },
}
const SEARCH = {
  name: 'search',
  description: 'Search the company record. Returns results with ids to pass to fetch.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}
const FETCH = {
  name: 'fetch',
  description: 'The full text of a search result by its id.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
}

async function call(ctx: ToolCtx, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === 'ask_company') {
    const pack = await buildContext(ctx.sql, ctx.tenantId, String(input.question ?? ''), { as: ctx.as, asOf: (input.as_of as string) || undefined, rewrite: true, limit: 15 })
    return { understood: pack.understood, facts: pack.facts, sources: pack.sources }
  }
  if (name === 'search') {
    const r = (await searchCompany(ctx, { query: String(input.query ?? ''), limit: 15 })) as { results?: { id: string; title?: string; where?: string }[] }
    return { results: (r.results ?? []).map((x) => ({ id: x.id, title: x.title ?? x.id, url: `${SOURCE_URL}?id=${encodeURIComponent(x.id)}` })) }
  }
  if (name === 'fetch') {
    const id = String(input.id ?? '')
    const d = (await openSource(ctx, { id })) as { error?: string; title?: string; text?: string; where?: string }
    if (d.error) return { id, title: id, text: d.error, url: `${SOURCE_URL}?id=${encodeURIComponent(id)}` }
    return { id, title: d.title ?? id, text: d.text ?? '', url: `${SOURCE_URL}?id=${encodeURIComponent(id)}`, metadata: { where: d.where ?? null } }
  }
  return runTool(ctx, name, input)
}

function mcpServer(ctx: ToolCtx & { who: string }): Server {
  const server = new Server({ name: 'company-brain', version: '1.0.0' }, { capabilities: { tools: {} } })
  const specs = [ASK, SEARCH, FETCH, ...TOOL_SPECS]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((s) => ({ name: s.name, description: `${s.description} (Answers as ${ctx.who}.)`, inputSchema: s.input_schema as { type: 'object'; properties?: Record<string, unknown> } })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t0 = Date.now()
    try {
      const out = await call(ctx, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
      log(`${req.params.name} ${Date.now() - t0}ms`)
      const text = JSON.stringify(out)
      // search/fetch: also as structured content (what ChatGPT reads); everything as text for other clients.
      return { content: [{ type: 'text', text }], ...(req.params.name === 'search' || req.params.name === 'fetch' ? { structuredContent: out as Record<string, unknown> } : {}) }
    } catch (e) {
      log(`${req.params.name} failed: ${(e as Error).message}`)
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true }
    }
  })
  return server
}

const ctx = await context()
log(`tenant ${SLUG}, answering as ${ctx.who}`)

if (!process.argv.includes('--http')) {
  await mcpServer(ctx).connect(new StdioServerTransport())
} else {
  const secret = process.env.CB_MCP_SECRET
  if (!secret || secret.length < 16) throw new Error('Set CB_MCP_SECRET (16+ characters): the URL path is the only protection over HTTP')
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  createServer(async (req, res) => {
    if (!req.url?.startsWith(`/mcp/${secret}`)) {
      res.writeHead(404).end()
      return
    }
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? sessions.get(sid) : undefined
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void sessions.set(id, transport!) })
      transport.onclose = () => transport?.sessionId && sessions.delete(transport.sessionId)
      await mcpServer(ctx).connect(transport)
    }
    await transport.handleRequest(req, res)
  }).listen(PORT, () => log(`HTTP on http://localhost:${PORT}/mcp/<secret>`))
}
