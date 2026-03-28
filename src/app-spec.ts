import type {
  CoreSchema,
  Skill,
  ToolExecutionResult,
  TopologyNode,
  TurnRecord,
  MemoryEngine,
  SessionMeta,
  SessionTree,
} from '@stello-ai/core'

/** 自定义工具执行时可用的上下文能力。 */
export interface TemplateToolContext {
  currentSessionId: string
  sessions: SessionTree
  memory: MemoryEngine
  getSessionMeta(sessionId: string): Promise<SessionMeta>
  createChildSession(options: { parentId: string; label: string; scope?: string }): Promise<TopologyNode>
  appendNote(content: string): Promise<void>
  readNote(): Promise<string | null>
}

/** 模板工具定义。 */
export interface TemplateTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(context: TemplateToolContext, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

/** 模板应用的声明式配置。 */
export interface StelloTemplateSpec {
  appName: string
  rootLabel: string
  dataDir: string
  host?: string
  schema: CoreSchema
  mainSystemPrompt: string
  createChildSystemPrompt(scope: string, label: string): string
  consolidatePrompt: string
  integratePrompt: string
  llm: {
    model: string
    baseURL: string
    apiKeyEnv: string
    maxContextTokens: number
    temperature?: number
    maxTokens?: number
  }
  scheduler?: {
    consolidateEveryNTurns?: number
  }
  tools?: TemplateTool[]
  skills?: Skill[]
  bootstrapRecords?: Array<{ role: TurnRecord['role']; content: string }>
}

/** 默认模板配置：中性多会话编排骨架。 */
export const appSpec: StelloTemplateSpec = {
  appName: 'My Stello App',
  rootLabel: 'Main Session',
  dataDir: './tmp/stello-app',
  host: process.env.DEMO_HOST ?? '127.0.0.1',
  schema: {
    name: { type: 'string', default: '', bubbleable: true },
    goal: { type: 'string', default: '', bubbleable: true },
    topics: { type: 'array', default: [], bubbleable: true },
  },
  mainSystemPrompt: `你是应用的主会话，负责理解用户目标、拆分子任务，并综合多个子会话的结果给出最终结论。

工作方式：
- 当用户问题出现新的主题、领域、地区、模块或工作流时，主动调用 stello_create_session 创建对应子会话
- 主会话负责拆解、协调和汇总，不需要自己展开所有细节
- 子会话负责各自范围内的深入分析和执行

回答风格：
- 中文为主
- 先澄清目标，再给结构化输出
- 尽量让主会话回答体现“调度和汇总”的角色，而不是包办所有细节`,
  createChildSystemPrompt(scope: string, label: string) {
    return `你是子会话 \"${label}\"，只负责 ${scope} 这个范围。

职责：
- 聚焦 ${scope} 范围内的信息、决策、风险和建议
- 输出可复用、可整合的清晰结论
- 当问题继续细分时，可以调用 stello_create_session 创建更细的子会话
- 当出现关键结论时，可以调用 save_note 保存给主会话和其他分支参考`
  },
  consolidatePrompt: `你是会话摘要整理助手。请把当前会话对话提炼为一段简洁摘要。

要求：
- 100-150 字
- 只保留已确认的信息、关键判断和下一步建议
- 不要写过程，不要写 Markdown 列表`,
  integratePrompt: `你是多会话整合器。你会收到多个子会话的摘要。

请输出 JSON：
{
  "synthesis": "全局综合结论",
  "insights": [
    { "sessionId": "会话 ID", "content": "给该会话的定向补充信息" }
  ]
}

要求：
- synthesis 要总结共性、差异、冲突和后续建议
- insights 要把其他分支中值得参考的发现定向回传给对应会话`,
  llm: {
    model: process.env.OPENAI_MODEL ?? 'MiniMax-M2.7',
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.minimaxi.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    maxContextTokens: 128000,
    temperature: 0.7,
    maxTokens: 2048,
  },
  scheduler: {
    consolidateEveryNTurns: 3,
  },
  bootstrapRecords: [
    { role: 'assistant', content: '欢迎使用 Stello Template。你可以试试：帮我拆分这个任务，并为不同方向创建子会话。' },
  ],
}
