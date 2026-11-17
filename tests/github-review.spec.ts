import { expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { closedComment, receiveIssue, reviewComment, reviewIssue } from '../src/sources/github-review.ts'
import type { GithubConfig } from '../src/sources/github.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A report whose fields are all present but not filled: the shape a held Issue has. */
const EMPTY_FIELDS = `### 提交前自查

- [x] 我已把现象和截图先交给 Agent 排查，下面的内容是整理后的结果

### 项目 / 插件版本

0.2.56

### 运行环境

workbuddy

### 实际现象与期望行为

<img width="679" height="452" alt="image" src="https://github.com/user-attachments/assets/6711a64d-8e89-46d9-926c-b2592048a2d5" />

### 最小复现步骤

1.
2.
3.

### 完整报错文本或日志

\`\`\`text
xxx
\`\`\`

### 截图 / 录屏（可选）

_No response_`

/** A report that carries a log, steps and the host version: the shape a released Issue has. */
const FULL = `### 插件版本

0.2.56

### Magpie 版本

1.3.0

### 使用宿主及版本

DSH 桌面版 0.2.2

### 操作系统与部署方式

Windows 11 原生安装

### 完整模型名

deepseek-v4-1-flash-261017

### 实际现象

选中该模型后发消息，界面提示 invalid parameter，没有返回任何内容。

### 期望行为

应当正常返回模型回复。

### 最小复现步骤

1. 打开设置，选 deepseek-v4-1-flash-261017
2. 新开对话发一句「你好」
3. 观察界面提示 invalid parameter，无回复

### 完整报错文本或日志

\`\`\`text
HTTP 400 invalid parameter: model not allowed for this account
at loader.mjs:512
\`\`\``

const config = (overrides: Partial<GithubConfig> = {}): GithubConfig => ({ repository: 'acme/widgets', cli: 'gh', pollSeconds: 60,
  failuresBeforeError: 3, observeIssues: true, observePulls: false, observeComments: false, observeCi: false, reviewIssues: true,
  reviewHours: 48, ...overrides })

/** A SourceContext that records what reaches the domain and answers GitHub calls without a network. */
function context() {
  const store = new Map<string, unknown>()
  const api = vi.fn(async (_schema: unknown, path: string) => path.startsWith('labels/') ? { name: 'needs-info' } : {})
  const pages = vi.fn(async () => [] as { body?: string | null }[])
  const receive = vi.fn((_trigger: Trigger) => ({ accepted: true }))
  const ctx = { deployment: testDeployment(), commands: { api, pages }, receive, atomic: <T>(work: () => T): T => work(),
    state: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => { if (value === undefined) store.delete(key); else store.set(key, value) },
      keys: () => [] } }
  return { ...ctx, api, pages } as unknown as SourceContext & { receive: ReturnType<typeof vi.fn>; api: ReturnType<typeof vi.fn> }
}

it('holds an Issue whose fields are filled with placeholders', () => {
  const review = reviewIssue({ title: '[Bug] 升级版本（0.2.56）后出现  503 风控', body: EMPTY_FIELDS })
  expect(review.verdict).toBe('hold')
  expect(review.reasons.join('\n')).toContain('numbers steps that are not there')
  expect(review.reasons.join('\n')).toContain('only a placeholder')
  expect(review.reasons.join('\n')).toContain('checked by an agent')
})

it('passes a report that carries a version, a host, steps and a log', () => {
  expect(reviewIssue({ title: '[Bug] 选模型后报 invalid parameter', body: FULL })).toEqual({ verdict: 'pass', reasons: [] })
})

it('holds a report that answers every field with 无', () => {
  const review = reviewIssue({ title: '[Bug] 用不了', body: `### 插件版本\n\n0.2.56\n\n### 运行环境\n\nWindows\n\n### 实际现象\n\n用不了\n\n### 最小复现步骤\n\n1.\n2.\n\n### 完整报错文本或日志\n\n无` })
  expect(review.verdict).toBe('hold')
  expect(review.reasons.join('\n')).toContain('placeholder')
})

it('passes a hand-written report with a log, a table and a status code but no form headings', () => {
  const body = `## 现象\n\n设置首行后，上游收到的仍是原文。\n\n| 请求 | 首行字符数 | 上游收到字节 |\n|---|---|---|\n| A | 57 | 250 |\n| B | 177 | 371 |\n\n` +
    '```js\nfunction withFirstLine(messages, text) { return messages }\n```\n\n差值是 121，正好等于多加的字符数。\n\n' +
    '`/v1/messages` 的 system 在顶层，`messages[]` 里没有，所以替换是空操作。\n\n第一次请求返回 200，第二次返回 403。\n\n' +
    '建议把首行改写做成一个按协议取放 system 文本的函数，供 always 与 blocked 两条路共用，并在 `/v1/messages`、`/v1/responses` 两处都接上，' +
    '同时补一条用例覆盖带 cache_control 的数据块数组。'
  expect(reviewIssue({ title: 'loader: 首行改写不生效', body }).verdict).toBe('pass')
})

it('holds a hand-written report that is long but says nothing checkable', () => {
  const review = reviewIssue({ title: '插件好像有问题', body: '升级之后插件就用不了了，之前一直是好的，现在发消息没反应，重装也没用，希望作者看一下。'.repeat(6) })
  expect(review.verdict).toBe('hold')
  expect(review.reasons.join('\n')).toContain('no error and no version number')
})

it('answers a held Issue once with the reasons and the wait', () => {
  const comment = reviewComment({ verdict: 'hold', reasons: ['“最小复现步骤” numbers steps that are not there'] }, 48)
  expect(comment).toContain('<!-- dsh-superagent:issue-review:held -->')
  expect(comment).toContain('numbers steps that are not there')
  expect(comment).toContain('48 hours')
  expect(closedComment(48)).toContain('<!-- dsh-superagent:issue-review:closed -->')
})

it('receives a new Issue untouched while the review is off', async () => {
  const ctx = context()
  await receiveIssue(ctx, { number: 12, title: 'x', body: EMPTY_FIELDS, state: 'open', created_at: '2026-11-17T00:00:00Z', html_url: '', user: { login: 'dana' } } as never, config({ reviewIssues: false }))
  expect(ctx.receive).toHaveBeenCalledTimes(1)
  expect(ctx.api).not.toHaveBeenCalled()
})

it('holds a new Issue, replies once and records it instead of receiving it', async () => {
  const ctx = context()
  await receiveIssue(ctx, { number: 12, title: '[Bug] 升级版本后出现 503 风控', body: EMPTY_FIELDS, state: 'open',
    created_at: '2026-11-17T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/12', user: { login: 'dana' } } as never, config())
  expect(ctx.receive).not.toHaveBeenCalled()
  expect(ctx.api).toHaveBeenCalledWith(expect.anything(), 'issues/12/comments', '--method', 'POST', '-f', expect.stringContaining('dsh-superagent:issue-review:held'))
  expect(ctx.state.get(KV.github.held)).toMatchObject({ '12': { at: expect.any(String) } })
})

it('releases an Issue that carries a report while the review is on', async () => {
  const ctx = context()
  await receiveIssue(ctx, { number: 13, title: '[Bug] 选模型后报 invalid parameter', body: FULL, state: 'open',
    created_at: '2026-11-17T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/13', user: { login: 'dana' } } as never, config())
  expect(ctx.receive).toHaveBeenCalledTimes(1)
  expect(ctx.state.get(KV.github.held)).toBeUndefined()
})
