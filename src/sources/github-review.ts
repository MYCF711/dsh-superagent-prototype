/** Optional review of newly opened Issues: an Issue that carries no usable report is held before any Eval, so the agent spends no attention on it. */
import { z } from 'zod'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { GithubConfig } from './github.ts'
import { IssueSchema, issueTrigger, type GithubIssue } from './github-trigger.ts'
import type { SourceContext } from './host.ts'

/** One held Issue: when it was held, so the sweep can close it after the configured wait. */
export interface HeldIssue { at: string }
/** Whether an Issue carries a report an assessment can work from. */
export type IssueVerdict = 'pass' | 'hold'
/** Outcome of one Issue review, with the lines the reply to its author shows. */
export interface IssueReview { verdict: IssueVerdict; reasons: string[] }

/** Field headings, by the names the Issue forms and hand-written reports use; the first match wins, longest first. */
const FIELDS = {
  version: ['plugin version', 'version', '插件版本', '项目 / 插件版本', '项目/插件版本'],
  env: ['host', 'environment', '运行环境', '使用宿主及版本', '操作系统与部署方式'],
  actual: ['what happened', 'actual behaviour', 'actual behavior', '实际现象', '现象'],
  steps: ['steps to reproduce', 'reproduction steps', 'how to reproduce', '最小复现步骤', '复现步骤'],
  logs: ['logs', 'log', 'error output', '完整报错文本或日志', '报错日志', '日志'],
} as const satisfies Record<string, readonly string[]>
type FieldKey = keyof typeof FIELDS
/** The fields a report needs; a missing one is why an Issue is held. */
const REQUIRED: readonly FieldKey[] = ['version', 'env', 'actual', 'steps', 'logs']

/** A section holding only one of these has no report in it. */
const PLACEHOLDER = /^(?:x+|×+|\.+|…+|。+|-+|_+|\*+|无|没有|无内容|同上|test|测试|asdf|abc|todo|tbd|待补充|待定|不知道|暂无|n\/?a|none|null|no\s*response|\d+)$/i
/** Marks text that looks like a real error, which a report's log or description should carry somewhere. */
const SIGNAL = /(error|exception|failed|failure|traceback|stack|at\s+[A-Za-z_$][\w$]*\s*\(|ECONN|ETIMEDOUT|ENOTFOUND|E[A-Z]{3,}\b|TypeError|SyntaxError|status|http\/|timeout|refused|invalid|cannot|undefined|401|403|404|429|500|502|503)/i
const SYSTEM = /(windows|win\d*|linux|ubuntu|debian|centos|macos|mac os|darwin|docker|fnos|飞牛|群晖|unraid|android|安卓)/i
/** Minimum characters of usable text in a field; short of it, the field says nothing an assessment can use. */
const MINIMUM: Record<FieldKey, number> = { version: 2, env: 4, actual: 12, steps: 8, logs: 20 }

/** Removes what cannot count as report text: images, links, HTML, checkboxes and code-fence marks (the code inside them stays). */
export const reportText = (raw: string): string => raw
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<img\b[^>]*>/gi, ' ')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/^\s*[-*]\s*\[[ xX]\]\s*/gm, '')
  .replace(/```[a-zA-Z0-9_+-]*/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .trim()
/** A numbered list of nothing (`1.` `2.` `3.`) leaves no step behind once its numbers are gone. */
export const withoutOrdinals = (text: string): string => text
  .replace(/^\s*(?:\d+\s*[.、)]|[-*•①②③④⑤])\s*/gm, '')
  .replace(/\s+/g, '')
  .trim()

/** Splits a report into `##`/`###` sections; both the Issue forms and hand-written reports use these headings. */
export function sections(body: string): { title: string; text: string }[] {
  const marks = [...body.matchAll(/^#{2,3}[ \t]+(.+?)[ \t]*$/gm)]
  return marks.map((mark, index) => ({
    title: mark[1]!,
    text: body.slice(mark.index! + mark[0].length, index + 1 < marks.length ? marks[index + 1]!.index! : body.length),
  }))
}

/** Maps a section heading to its field; the longest matching name wins, so `Magpie version` is not read as `version`. */
export function fieldOf(title: string): FieldKey | undefined {
  const normalized = title.replace(/\s+/g, '').toLowerCase()
  let best: { key: FieldKey; length: number } | undefined
  for (const [key, names] of Object.entries(FIELDS) as [FieldKey, readonly string[]][]) {
    for (const name of names) {
      const candidate = name.replace(/\s+/g, '')
      if (normalized.includes(candidate) && (!best || candidate.length > best.length)) best = { key, length: candidate.length }
    }
  }
  return best?.key
}

/** Decides whether common report text is usable, and names the heading it came from when it is not. */
function usable(key: FieldKey, title: string, raw: string, reasons: string[]): string | undefined {
  const text = reportText(raw)
  const flat = text.replace(/\s+/g, '')
  if (!flat) { reasons.push(`“${title}” is empty`); return undefined }
  if (PLACEHOLDER.test(flat)) { reasons.push(`“${title}” holds only a placeholder (${flat.slice(0, 16)})`); return undefined }
  if (key === 'steps') {
    const bare = withoutOrdinals(text)
    if (!bare) { reasons.push(`“${title}” numbers steps that are not there`); return undefined }
    if (bare.length < MINIMUM.steps) { reasons.push(`“${title}” is too short to replay`); return undefined }
    return text
  }
  if (key === 'env' && !/\d/.test(flat) && !SYSTEM.test(flat)) {
    reasons.push(`“${title}” names no host version`); return undefined
  }
  if (flat.length < MINIMUM[key]) { reasons.push(`“${title}” is too short to use`); return undefined }
  return text
}

/**
 * Reviews an Issue's title and body and decides whether it carries a reproducible report.
 * A report the fields cannot be read from (no `##` headings, for instance) is judged by its own extent:
 * a long, detailed body with a log, a table or commands passes, while a long body of generalities does not.
 */
export function reviewIssue(input: { title: string; body?: string | null }): IssueReview {
  const body = input.body ?? ''
  const reasons: string[] = []
  const found = new Map<FieldKey, string>()
  const seen = new Set<FieldKey>()
  for (const section of sections(body)) {
    const key = fieldOf(section.title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const text = usable(key, section.title, section.text, reasons)
    if (text) found.set(key, text)
  }
  // One recognizable heading is a hand-written report that happens to use a form's word; judge it by its extent.
  if (seen.size < 2) return freeformReview(body)
  for (const key of [...REQUIRED].reverse()) {
    if (!seen.has(key)) reasons.unshift(`“${FIELDS[key][0]}” is missing`)
  }
  const title = input.title.replace(/^\s*\[[^\]]*\]\s*/, '').trim()
  if (title.length < 6) reasons.push('the title says almost nothing')
  // A claim that the report was already put in order, with nothing in the report to show for it.
  if (reasons.length && /agent|assistant|助手|已排查|整理/i.test(body) && found.size <= 2) {
    reasons.push('it says the report was checked by an agent, but carries no result')
  }
  return { verdict: found.size === REQUIRED.length ? 'pass' : 'hold', reasons }
}

/** Judges a body with no recognizable headings by how much evidence it carries, not by how long it is. */
function freeformReview(body: string): IssueReview {
  const text = reportText(body)
  const flat = text.replace(/\s+/g, '')
  const detail = (body.match(/```[\s\S]*?```/g) ?? []).length >= 1
    || (body.match(/^\s*\|.*\|\s*$/gm) ?? []).length >= 3
    || (body.match(/`[^`\n]+`/g) ?? []).length >= 2
  const evidence = SIGNAL.test(text) || /\b\d+\.\d+\.\d+\b/.test(text)
  if (flat.length >= 160 && detail && evidence) return { verdict: 'pass', reasons: [] }
  const reasons: string[] = []
  if (flat.length < 160) reasons.push(`the description carries only ${flat.length} characters of usable text`)
  if (!detail) reasons.push('no command, path, log or table shows what was run')
  if (!evidence) reasons.push('no error and no version number appear')
  return { verdict: 'hold', reasons }
}

/** Comment markers, so retries and later rounds never post the same reply twice. */
const HELD_MARK = '<!-- dsh-superagent:issue-review:held -->'
const CLOSED_MARK = '<!-- dsh-superagent:issue-review:closed -->'
/** The label a held Issue carries until it is completed or closed. */
export const HELD_LABEL = 'needs-info'

/** The reply a held Issue receives: what it is missing, and what happens next. */
export function reviewComment(review: IssueReview, hours: number): string {
  return `${HELD_MARK}
This Issue does not yet carry a report that can be reproduced, so it has not been handed to the agent.

What is missing or unusable:

${review.reasons.map(reason => `- ${reason}`).join('\n')}

Reply with those details and it is checked again automatically. Without an answer it is closed after ${hours} hours, and can be reopened then.`
}

/** The reply a held Issue receives when the wait is over. */
export function closedComment(hours: number): string {
  return `${CLOSED_MARK}
No reproducible report arrived within ${hours} hours, so this Issue was closed to keep it out of the queue. Add the missing details and reopen it whenever you can.`
}

const LABEL_SCHEMA = z.looseObject({ name: z.string() })
const COMMENT_SCHEMA = z.looseObject({ body: z.string().nullish() })
/** True when GitHub reports the Issue or the label as already gone, so the sweep can forget it instead of retrying. */
const GONE = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410 || error.code === 403)

/** Adds the held label without failing the review when the account may not manage labels. */
async function label(ctx: SourceContext, number: number): Promise<void> {
  const commands = ctx.commands
  try {
    await commands.api(LABEL_SCHEMA, `labels/${HELD_LABEL}`).catch(async error => {
      if (!GONE(error)) throw error
      await commands.api(z.unknown(), 'labels', '--method', 'POST', '-f', `name=${HELD_LABEL}`, '-f', 'color=fbca04',
        '-f', 'description=A report that needs more detail before it can be worked on')
    })
    await commands.api(z.unknown(), `issues/${number}/labels`, '--method', 'POST', '-f', `labels[]=${HELD_LABEL}`)
  } catch { /* The reply carries the message when labels are unavailable. */ }
}
/** Removes the held label, ignoring an Issue that no longer carries it. */
async function unlabel(ctx: SourceContext, number: number): Promise<void> {
  await ctx.commands.api(z.unknown(), `issues/${number}/labels/${encodeURIComponent(HELD_LABEL)}`, '--method', 'DELETE').catch(() => {})
}
/** Posts `body` once; a marker already present in the conversation means it was posted before. */
async function reply(ctx: SourceContext, number: number, body: string): Promise<void> {
  const marker = body.slice(0, body.indexOf('\n'))
  const posted = (await ctx.commands.pages(COMMENT_SCHEMA, `issues/${number}/comments`)).some(comment => (comment.body ?? '').includes(marker))
  if (!posted) await ctx.commands.api(z.unknown(), `issues/${number}/comments`, '--method', 'POST', '-f', `body=${body}`)
}
/** Holds an Issue: labels it, replies once with what is missing, and records it for the sweep. */
export async function holdIssue(ctx: SourceContext, issue: GithubIssue, review: IssueReview, config: GithubConfig): Promise<void> {
  await label(ctx, issue.number)
  await reply(ctx, issue.number, reviewComment(review, config.reviewHours))
  const held = { ...ctx.state.get(KV.github.held), [String(issue.number)]: { at: new Date().toISOString() } }
  ctx.atomic(() => ctx.state.set(KV.github.held, held))
}

/**
 * Receives a newly opened Issue, or holds it when the optional review is on and it carries no reproducible report.
 * A held Issue never enters the domain: no Eval reads it, and no Ticket, Session or reply of the agent is spent on it.
 */
export async function receiveIssue(ctx: SourceContext, issue: GithubIssue, config: GithubConfig): Promise<void> {
  const trigger = issueTrigger(issue, ctx.deployment.github.login)
  if (!config.reviewIssues) { await ctx.receive(trigger); return }
  const review = reviewIssue(issue)
  if (review.verdict === 'pass') { await ctx.receive(trigger); return }
  await holdIssue(ctx, issue, review, config)
}

/** Whether enough time passed since the last sweep; the review reads each held Issue, so it does not run every poll. */
export function sweepDue(ctx: SourceContext): boolean {
  const last = ctx.state.get(KV.github.reviewSwept)
  return !last || Date.now() - Date.parse(last) >= 10 * 60_000
}

/**
 * Re-reads every held Issue: one that now carries a report is released into the domain, one whose wait ran out is
 * closed, and one that no longer exists, or is no longer open, is forgotten.
 */
export async function sweepHeldIssues(ctx: SourceContext, signal: AbortSignal | undefined, config: GithubConfig): Promise<void> {
  const held = { ...ctx.state.get(KV.github.held) }
  const commands = ctx.commands.withSignal(signal)
  for (const [name, record] of Object.entries(held)) {
    const number = Number(name)
    if (!record || !number) { delete held[name]; continue }
    const issue = await commands.api(IssueSchema, `issues/${number}`).catch((error: unknown) => {
      if (!GONE(error)) throw error
      delete held[name]
      return undefined
    })
    if (!issue) continue
    if (issue.state !== 'open' || issue.pull_request) { delete held[name]; continue }
    const review = reviewIssue(issue)
    if (review.verdict === 'pass') {
      delete held[name]
      await unlabel(ctx, number)
      await ctx.receive(issueTrigger(issue, ctx.deployment.github.login))
      continue
    }
    if (Date.now() - Date.parse(record.at) < config.reviewHours * 3_600_000) continue
    delete held[name]
    await reply(ctx, number, closedComment(config.reviewHours))
    await commands.api(z.unknown(), `issues/${number}`, '--method', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=not_planned')
  }
  ctx.atomic(() => {
    ctx.state.set(KV.github.held, Object.keys(held).length ? held : undefined)
    ctx.state.set(KV.github.reviewSwept, new Date().toISOString())
  })
}
