import { randomUUID } from 'node:crypto'
import { basename, extname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'caw-runner'
export const inject = ['agentDefaultModel', 'agents', 'attachments', 'sessions']

export const Config = Schema.object({
  imagePath: Schema.string().required(),
  instruction: Schema.string().required(),
})

const MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

function finalText(events, firstSeq) {
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const current = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (current !== '') text = current
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const imagePath = resolve(config.imagePath)
  const mediaType = MEDIA_TYPES.get(extname(imagePath).toLowerCase())
  if (mediaType === undefined) throw new Error('input image must be PNG, JPEG, WebP, or GIF')
  const attachment = await ctx.attachments.saveImage({
    data: await readFile(imagePath),
    mediaType,
    name: basename(imagePath),
  })
  const selection = ctx.agentDefaultModel.currentSelection()
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(`caw-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [
      { type: 'image', attachment },
      { type: 'text', text: config.instruction },
    ],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  const outcome = finalText(agent.session.events, firstSeq)
  io.stdout.write(`${outcome.text || 'Episode finished.'}\n`)
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('caw-runner requires the dsh application launcher')
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  void run(ctx, config, io).catch((error) => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
