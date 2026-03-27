import {
  NodeFileSystemAdapter,
  SessionTreeImpl,
  SkillRouterImpl,
  Scheduler,
  createDefaultConsolidateFn,
  createDefaultIntegrateFn,
  createStelloAgent,
  type ConfirmProtocol,
  type EngineLifecycleAdapter,
  type EngineToolRuntime,
  type LLMCallFn,
  type MemoryEngine,
  type SessionMeta,
  type Skill,
  type SkillRouter,
  type StelloAgent,
  type StelloAgentConfig,
  type ToolExecutionResult,
  type TopologyNode,
  type TurnRecord,
} from '@stello-ai/core'
import { startDevtools, type DevtoolsInstance } from '@stello-ai/devtools'
import {
  InMemoryStorageAdapter,
  createOpenAICompatibleAdapter,
  loadMainSession,
  loadSession,
  type MainSession,
  type Session,
  type SessionMeta as SessionComponentMeta,
} from '@stello-ai/session'
import type { StelloTemplateSpec, TemplateToolContext } from './app-spec.js'

interface WrappedSession {
  session: Session
  main?: never
}

interface WrappedMainSession {
  main: MainSession
  session?: never
}

interface LocalDevtoolsPersistedState {
  hotConfig?: {
    runtime?: { idleTtlMs?: number }
    scheduling?: {
      consolidation?: { trigger?: string; everyNTurns?: number }
      integration?: { trigger?: string; everyNTurns?: number }
    }
    splitGuard?: { minTurns?: number; cooldownTurns?: number }
  }
  llm?: {
    model: string
    baseURL: string
    apiKey?: string
    temperature?: number
    maxTokens?: number
  }
  prompts?: {
    consolidate?: string
    integrate?: string
  }
  disabledTools?: string[]
  disabledSkills?: string[]
}

interface LocalDevtoolsStateStore {
  load(): Promise<LocalDevtoolsPersistedState | null>
  save(state: LocalDevtoolsPersistedState): Promise<void>
  reset?(): Promise<void>
}

interface PersistedTurnRecord extends Omit<TurnRecord, 'role'> {
  role: TurnRecord['role'] | 'tool'
}

interface LocalMemoryEngine extends MemoryEngine {
  replaceRecords?(sessionId: string, records: PersistedTurnRecord[]): Promise<void>
}

interface SessionMessageWithToolCalls {
  role: TurnRecord['role'] | 'tool'
  content: string
  timestamp?: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
}

/** 支持运行时启停的 SkillRouter 包装。 */
class ToggleableSkillRouter implements SkillRouter {
  constructor(
    private readonly base: SkillRouter,
    private readonly disabledSkills: Set<string>,
  ) {}

  /** 注册 skill 到底层 router。 */
  register(skill: Skill): void {
    this.base.register(skill)
  }

  /** 匹配 skill 时跳过被禁用项。 */
  match(message: TurnRecord): Skill | null {
    const matched = this.base.match(message)
    if (!matched) return null
    return this.disabledSkills.has(matched.name) ? null : matched
  }

  /** 列举时带上当前启用过滤。 */
  getAll(): Skill[] {
    return this.base.getAll().filter((skill) => !this.disabledSkills.has(skill.name))
  }
}

/** 同步子会话 insight 到文件层镜像。 */
async function syncSessionScopeMirror(
  sessionId: string,
  session: Session,
  memoryEngine: MemoryEngine,
): Promise<void> {
  const insight = await session.insight()
  await memoryEngine.writeScope(sessionId, insight ?? '')
}

/** 读取持久化的 session system prompt。 */
async function readPersistedSystemPrompt(
  fs: NodeFileSystemAdapter,
  sessionId: string,
): Promise<string | null> {
  return fs.readJSON<string>(`memory/sessions/${sessionId}/system-prompt.json`).catch(() => null)
}

/** 写入持久化的 session system prompt。 */
async function writePersistedSystemPrompt(
  fs: NodeFileSystemAdapter,
  sessionId: string,
  content: string,
): Promise<void> {
  await fs.writeJSON(`memory/sessions/${sessionId}/system-prompt.json`, content)
}

/** 创建模板使用的文件型 DevTools state store。 */
function createFileDevtoolsStateStore(fs: NodeFileSystemAdapter): LocalDevtoolsStateStore {
  const path = 'memory/devtools-state.json'
  return {
    async load(): Promise<LocalDevtoolsPersistedState | null> {
      return fs.readJSON<LocalDevtoolsPersistedState>(path).catch(() => null)
    },
    async save(state: LocalDevtoolsPersistedState): Promise<void> {
      await fs.writeJSON(path, state)
    },
    async reset(): Promise<void> {
      await fs.writeJSON(path, {})
    },
  }
}

/** 把已持久化的调试状态恢复到模板运行时。 */
function applyPersistedState(
  state: LocalDevtoolsPersistedState | null,
  setters: {
    setPrompts: (next: NonNullable<LocalDevtoolsPersistedState['prompts']>) => void
    setLlmConfig: (next: NonNullable<LocalDevtoolsPersistedState['llm']>) => void
    setDisabledTools: (names: string[]) => void
    setDisabledSkills: (names: string[]) => void
  },
): void {
  if (!state) return
  if (state.prompts) setters.setPrompts(state.prompts)
  if (state.llm) setters.setLlmConfig(state.llm)
  if (state.disabledTools) setters.setDisabledTools(state.disabledTools)
  if (state.disabledSkills) setters.setDisabledSkills(state.disabledSkills)
}

/** 持久化当前模板里的 DevTools 全局状态。 */
async function persistDevtoolsState(
  stateStore: LocalDevtoolsStateStore,
  values: {
    llm: NonNullable<LocalDevtoolsPersistedState['llm']>
    prompts: NonNullable<LocalDevtoolsPersistedState['prompts']>
    disabledTools: string[]
    disabledSkills: string[]
  },
): Promise<void> {
  await stateStore.save({
    llm: {
      model: values.llm.model,
      baseURL: values.llm.baseURL,
      temperature: values.llm.temperature,
      maxTokens: values.llm.maxTokens,
    },
    prompts: values.prompts,
    disabledTools: values.disabledTools,
    disabledSkills: values.disabledSkills,
  })
}

/** 按 core session id 注册并加载标准 Session。 */
async function registerStandardSession(
  fs: NodeFileSystemAdapter,
  storage: InMemoryStorageAdapter,
  sessionId: string,
  label: string,
  systemPrompt: string,
  llm: ReturnType<typeof createOpenAICompatibleAdapter>,
  toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): Promise<Session> {
  const now = new Date().toISOString()
  const meta: SessionComponentMeta = {
    id: sessionId,
    label,
    role: 'standard',
    status: 'active',
    tags: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }
  const effectiveSystemPrompt = (await readPersistedSystemPrompt(fs, sessionId)) ?? systemPrompt
  await storage.putSession(meta)
  await storage.putSystemPrompt(sessionId, effectiveSystemPrompt)
  const session = await loadSession(sessionId, { storage, llm, tools: [...toolDefs] })
  if (!session) throw new Error(`Failed to load standard session: ${sessionId}`)
  return session
}

/** 按 core session id 注册并加载 MainSession。 */
async function registerMainSession(
  fs: NodeFileSystemAdapter,
  storage: InMemoryStorageAdapter,
  sessionId: string,
  label: string,
  systemPrompt: string,
  llm: ReturnType<typeof createOpenAICompatibleAdapter>,
  toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): Promise<MainSession> {
  const now = new Date().toISOString()
  const meta: SessionComponentMeta = {
    id: sessionId,
    label,
    role: 'main',
    status: 'active',
    tags: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }
  const effectiveSystemPrompt = (await readPersistedSystemPrompt(fs, sessionId)) ?? systemPrompt
  await storage.putSession(meta)
  await storage.putSystemPrompt(sessionId, effectiveSystemPrompt)
  const session = await loadMainSession(sessionId, { storage, llm, tools: [...toolDefs] })
  if (!session) throw new Error(`Failed to load main session: ${sessionId}`)
  return session
}

/** 把文件层镜像状态恢复到运行态 session storage。 */
async function hydrateRuntimeState(
  storage: InMemoryStorageAdapter,
  memory: MemoryEngine,
  sessionId: string,
): Promise<void> {
  const [records, l2, scope] = await Promise.all([
    memory.readRecords(sessionId).catch(() => []),
    memory.readMemory(sessionId).catch(() => null),
    memory.readScope(sessionId).catch(() => null),
  ])

  for (const record of records) {
    await storage.appendRecord(sessionId, {
      role: record.role,
      content: record.content,
      ...(record.metadata?.toolCallId && typeof record.metadata.toolCallId === 'string'
        ? { toolCallId: record.metadata.toolCallId }
        : {}),
      ...(Array.isArray(record.metadata?.toolCalls)
        ? {
            toolCalls: record.metadata.toolCalls as Array<{
              id: string
              name: string
              input: Record<string, unknown>
            }>,
          }
        : {}),
      timestamp: record.timestamp,
    })
  }
  if (l2) {
    await storage.putMemory(sessionId, l2)
  }
  if (scope) {
    await storage.putInsight(sessionId, scope)
  }
}

/** 把普通 Session 适配成 core 需要的运行时对象。 */
function wrapStandardSession(sessionId: string, session: Session, memoryEngine: MemoryEngine) {
  return {
    get meta() {
      return { id: sessionId, status: session.meta.status } as const
    },
    async send(content: string) {
      const result = await session.send(content)
      await syncSessionScopeMirror(sessionId, session, memoryEngine)
      return result
    },
    stream(content: string) {
      const source = session.stream(content)
      return {
        result: (async () => {
          const result = await source.result
          await syncSessionScopeMirror(sessionId, session, memoryEngine)
          return result
        })(),
        async *[Symbol.asyncIterator]() {
          for await (const chunk of source) {
            yield chunk
          }
        },
      }
    },
    async messages() {
      return session.messages()
    },
    async consolidate(fn: (currentMemory: string | null, messages: Array<{ role: string; content: string; timestamp?: string }>) => Promise<string>) {
      await session.consolidate(fn)
      const l2 = await session.memory()
      if (l2) {
        await memoryEngine.writeMemory(sessionId, l2)
      }
    },
  }
}

/** 把 MainSession 适配成 core 需要的运行时对象。 */
function wrapMainSession(sessionId: string, main: MainSession) {
  return {
    get meta() {
      return { id: sessionId, status: main.meta.status } as const
    },
    async send(content: string) {
      return main.send(content)
    },
    stream(content: string) {
      return main.stream(content)
    },
    async messages() {
      return main.messages()
    },
    async consolidate() {
      // MainSession 不参与 L2 consolidation。
    },
  }
}

/** 创建文件持久化 MemoryEngine。 */
function createFileMemoryEngine(fs: NodeFileSystemAdapter, sessions: SessionTreeImpl, spec: StelloTemplateSpec): LocalMemoryEngine {
  const corePath = 'memory/core.json'
  const memPath = (id: string) => `memory/sessions/${id}/memory.json`
  const scopePath = (id: string) => `memory/sessions/${id}/scope.json`
  const indexPath = (id: string) => `memory/sessions/${id}/index.json`
  const recordsPath = (id: string) => `memory/sessions/${id}/records.json`

  return {
    async readCore(path?: string) {
      const data = (await fs.readJSON<Record<string, unknown>>(corePath)) ?? {
        name: spec.schema.name?.default ?? '',
        goal: spec.schema.goal?.default ?? '',
        topics: spec.schema.topics?.default ?? [],
      }
      if (!path) return data
      return data[path]
    },
    async writeCore(path: string, value: unknown) {
      const data = await this.readCore() as Record<string, unknown>
      data[path] = value
      await fs.writeJSON(corePath, data)
    },
    async readMemory(sessionId: string) {
      return fs.readJSON<string>(memPath(sessionId)).catch(() => null)
    },
    async writeMemory(sessionId: string, content: string) {
      await fs.writeJSON(memPath(sessionId), content)
    },
    async readScope(sessionId: string) {
      return fs.readJSON<string>(scopePath(sessionId)).catch(() => null)
    },
    async writeScope(sessionId: string, content: string) {
      await fs.writeJSON(scopePath(sessionId), content)
    },
    async readIndex(sessionId: string) {
      return fs.readJSON<string>(indexPath(sessionId)).catch(() => null)
    },
    async writeIndex(sessionId: string, content: string) {
      await fs.writeJSON(indexPath(sessionId), content)
    },
    async appendRecord(sessionId: string, record: TurnRecord) {
      const list = (await fs.readJSON<PersistedTurnRecord[]>(recordsPath(sessionId))) ?? []
      list.push(record)
      await fs.writeJSON(recordsPath(sessionId), list)
    },
    async replaceRecords(sessionId: string, records: PersistedTurnRecord[]) {
      await fs.writeJSON(recordsPath(sessionId), records)
    },
    async readRecords(sessionId: string) {
      return ((await fs.readJSON<PersistedTurnRecord[]>(recordsPath(sessionId))) ?? []) as TurnRecord[]
    },
    async assembleContext(sessionId: string) {
      const core = await this.readCore() as Record<string, unknown>
      const session = await sessions.getNode(sessionId)
      const currentMemory = await this.readMemory(sessionId)
      const scope = await this.readScope(sessionId)
      const parentMemories: string[] = []
      if (session?.parentId) {
        const parentMem = await this.readMemory(session.parentId)
        if (parentMem) parentMemories.push(parentMem)
      }
      return { core, memories: parentMemories, currentMemory, scope }
    },
  }
}

/** 读取 session 元数据，不存在时抛错。 */
async function requireSessionMeta(sessions: SessionTreeImpl, sessionId: string): Promise<SessionMeta> {
  const session = await sessions.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  return session
}

/** 读取拓扑节点，不存在时抛错。 */
async function requireNode(sessions: SessionTreeImpl, sessionId: string): Promise<TopologyNode> {
  const session = await sessions.getNode(sessionId)
  if (!session) throw new Error(`Session node not found: ${sessionId}`)
  return session
}

/** 创建模板自定义工具的执行上下文。 */
function createToolContext(
  sessions: SessionTreeImpl,
  memory: MemoryEngine,
  sessionId: string,
  createChildSession: (options: {
    parentId: string
    label: string
    scope?: string
    systemPrompt?: string
    prompt?: string
  }) => Promise<TopologyNode>,
): TemplateToolContext {
  return {
    currentSessionId: sessionId,
    sessions,
    memory,
    async getSessionMeta(targetSessionId: string) {
      return requireSessionMeta(sessions, targetSessionId)
    },
    async createChildSession(options) {
      return createChildSession(options)
    },
    async appendNote(content: string) {
      const existing = await memory.readScope(sessionId).catch(() => null)
      const updated = existing ? `${existing}\n\n---\n${content}` : content
      await memory.writeScope(sessionId, updated)
    },
    async readNote() {
      return memory.readScope(sessionId).catch(() => null)
    },
  }
}

/** 创建一个带完整 DevTools provider 的模板应用。 */
export async function createTemplateApp(spec: StelloTemplateSpec): Promise<{
  agent: StelloAgent
  startDevtools(options?: { port?: number; open?: boolean }): Promise<DevtoolsInstance>
}> {
  const apiKey = process.env[spec.llm.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`Missing ${spec.llm.apiKeyEnv}`)
  }

  const fs = new NodeFileSystemAdapter(spec.dataDir)
  const sessions = new SessionTreeImpl(fs)
  const sessionStorage = new InMemoryStorageAdapter()
  const sessionMap = new Map<string, WrappedSession | WrappedMainSession>()
  const memory = createFileMemoryEngine(fs, sessions, spec)
  const stateStore = createFileDevtoolsStateStore(fs)
  const disabledTools = new Set<string>()
  const disabledSkills = new Set<string>()
  const baseSkillRouter = new SkillRouterImpl()
  const skillRouter = new ToggleableSkillRouter(baseSkillRouter, disabledSkills)
  let currentToolSessionId: string | null = null
  let currentConsolidatePrompt = spec.consolidatePrompt
  let currentIntegratePrompt = spec.integratePrompt
  let currentLlm = createOpenAICompatibleAdapter({
    apiKey,
    baseURL: spec.llm.baseURL,
    model: spec.llm.model,
  })
  let currentLlmConfig = {
    model: spec.llm.model,
    baseURL: spec.llm.baseURL,
    apiKey,
    temperature: spec.llm.temperature ?? 0.7,
    maxTokens: spec.llm.maxTokens ?? 2048,
  }

  applyPersistedState(await stateStore.load(), {
    setPrompts(next) {
      if (next.consolidate) currentConsolidatePrompt = next.consolidate
      if (next.integrate) currentIntegratePrompt = next.integrate
    },
    setLlmConfig(next) {
      currentLlmConfig = {
        model: next.model,
        baseURL: next.baseURL,
        apiKey,
        temperature: next.temperature ?? currentLlmConfig.temperature,
        maxTokens: next.maxTokens ?? currentLlmConfig.maxTokens,
      }
      currentLlm = createOpenAICompatibleAdapter({
        apiKey,
        baseURL: currentLlmConfig.baseURL,
        model: currentLlmConfig.model,
      })
    },
    setDisabledTools(names) {
      disabledTools.clear()
      for (const name of names) disabledTools.add(name)
    },
    setDisabledSkills(names) {
      disabledSkills.clear()
      for (const name of names) disabledSkills.add(name)
    },
  })

  for (const skill of spec.skills ?? []) {
    skillRouter.register(skill)
  }

  const llmCall: LLMCallFn = async (messages) => {
    const result = await currentLlm.complete(
      messages.map((message) => ({ role: message.role as 'user' | 'assistant' | 'system', content: message.content })),
      { temperature: currentLlmConfig.temperature, maxTokens: currentLlmConfig.maxTokens },
    )
    return result.content ?? ''
  }

  const customTools = spec.tools ?? []
  const toolDefs = [
    {
      name: 'stello_create_session',
      description: 'Create a focused child session for a new topic, region, workstream, or specialist angle.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Visible child session label.' },
          systemPrompt: { type: 'string', description: 'Child session system prompt. Defaults to the inherited session prompt.' },
          prompt: { type: 'string', description: 'Assistant kickoff message shown as the first visible record inside the child session.' },
        },
        required: ['label'],
      },
    },
    {
      name: 'save_note',
      description: 'Save an important conclusion into the current session note so other sessions can reuse it later.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'Conclusion or key note to save.' },
        },
        required: ['note'],
      },
    },
    ...customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ]

  let rootId: string
  let rootLabel: string
  try {
    const root = await sessions.getRoot()
    rootId = root.id
    rootLabel = root.label
  } catch {
    const root = await sessions.createRoot(spec.rootLabel)
    rootId = root.id
    rootLabel = root.label
  }

  const mainSession = await registerMainSession(
    fs,
    sessionStorage,
    rootId,
    rootLabel,
    spec.mainSystemPrompt,
    currentLlm,
    toolDefs,
  )
  await hydrateRuntimeState(sessionStorage, memory, rootId)
  sessionMap.set(rootId, { main: mainSession })

  const allSessions = await sessions.listAll()
  for (const meta of allSessions) {
    if (meta.id === rootId || sessionMap.has(meta.id)) continue
    const childSession = await registerStandardSession(
      fs,
      sessionStorage,
      meta.id,
      meta.label,
      spec.createChildSystemPrompt(meta.scope ?? meta.label, meta.label),
      currentLlm,
      toolDefs,
    )
    await hydrateRuntimeState(sessionStorage, memory, meta.id)
    sessionMap.set(meta.id, { session: childSession })
  }

  const existingRootRecords = await memory.readRecords(rootId).catch(() => [])
  if (allSessions.length === 1 && existingRootRecords.length === 0 && spec.bootstrapRecords?.length) {
    for (const record of spec.bootstrapRecords) {
      await memory.appendRecord(rootId, {
        role: record.role,
        content: record.content,
        timestamp: new Date().toISOString(),
      })
    }
    await hydrateRuntimeState(sessionStorage, memory, rootId)
  }

  /** 创建子 session 并补齐运行态注册。 */
  const createChildSession = async (options: {
    parentId: string
    label: string
    scope?: string
    systemPrompt?: string
    prompt?: string
  }): Promise<TopologyNode> => {
    const child = await sessions.createChild({
      parentId: options.parentId,
      label: options.label,
      scope: options.scope,
    })
    const childSession = await registerStandardSession(
      fs,
      sessionStorage,
      child.id,
      child.label,
      options.systemPrompt ?? spec.createChildSystemPrompt(options.scope ?? child.label, child.label),
      currentLlm,
      toolDefs,
    )
    if (options.prompt) {
      const record = {
        role: 'assistant' as const,
        content: options.prompt,
        timestamp: new Date().toISOString(),
      }
      await sessionStorage.appendRecord(child.id, record)
      await memory.appendRecord(child.id, record)
    }
    sessionMap.set(child.id, { session: childSession })
    return child
  }

  const lifecycle: EngineLifecycleAdapter = {
    bootstrap: async (sessionId) => ({
      context: await memory.assembleContext(sessionId),
      session: await requireSessionMeta(sessions, sessionId),
    }),
    afterTurn: async (sessionId, userMsg, assistantMsg) => {
      const entry = sessionMap.get(sessionId)
      const runtimeSession = entry
        ? ('main' in entry && entry.main ? entry.main : entry.session)
        : null
      if (runtimeSession && memory.replaceRecords) {
        const records = await runtimeSession.messages() as SessionMessageWithToolCalls[]
        await memory.replaceRecords(sessionId, records.map((record) => ({
          role: record.role,
          content: record.content,
          timestamp: record.timestamp ?? new Date().toISOString(),
          ...(record.toolCallId || record.toolCalls
            ? {
                metadata: {
                  ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
                  ...(record.toolCalls ? { toolCalls: record.toolCalls } : {}),
                },
              }
            : {}),
        })))
      } else {
        await memory.appendRecord(sessionId, userMsg)
        await memory.appendRecord(sessionId, assistantMsg)
      }
      const current = await requireSessionMeta(sessions, sessionId)
      await sessions.updateMeta(sessionId, { turnCount: current.turnCount + 1 })
      return { coreUpdated: false, memoryUpdated: false, recordAppended: true }
    },
    prepareChildSpawn: createChildSession,
  }

  const allToolDefs = toolDefs.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }))

  const tools: EngineToolRuntime = {
    getToolDefinitions() {
      return allToolDefs.filter((tool) => !disabledTools.has(tool.name))
    },
    async executeTool(name, args): Promise<ToolExecutionResult> {
      if (!currentToolSessionId) {
        return { success: false, error: 'No active session context' }
      }

      if (name === 'stello_create_session') {
        const source = await requireNode(sessions, currentToolSessionId)
        const effectiveParentId = source.parentId === null ? source.id : (await sessions.getRoot()).id
        const parentEntry = sessionMap.get(currentToolSessionId)
        const inheritedSystemPrompt = parentEntry
          ? await ('main' in parentEntry && parentEntry.main
            ? parentEntry.main.systemPrompt()
            : parentEntry.session.systemPrompt())
          : null
        const child = await createChildSession({
          parentId: effectiveParentId,
          label: String(args.label ?? 'New Session'),
          systemPrompt: args.systemPrompt
            ? String(args.systemPrompt)
            : inheritedSystemPrompt ?? undefined,
          prompt: args.prompt ? String(args.prompt) : undefined,
        })
        return {
          success: true,
          data: {
            sessionId: child.id,
            label: child.label,
            parentId: child.parentId,
          },
        }
      }

      if (name === 'save_note') {
        const context = createToolContext(sessions, memory, currentToolSessionId, createChildSession)
        await context.appendNote(String(args.note ?? ''))
        return { success: true, data: { saved: true, sessionId: currentToolSessionId } }
      }

      const customTool = customTools.find((tool) => tool.name === name)
      if (!customTool) {
        return { success: false, error: `Unknown tool: ${name}` }
      }
      const context = createToolContext(sessions, memory, currentToolSessionId, createChildSession)
      return customTool.execute(context, args as Record<string, unknown>)
    },
  }

  const scheduler = new Scheduler({
    consolidation: { trigger: 'everyNTurns', everyNTurns: spec.scheduler?.consolidateEveryNTurns ?? 3 },
    integration: { trigger: 'afterConsolidate' },
  })

  const confirm: ConfirmProtocol = {
    async confirmSplit(proposal) {
      return createChildSession({
        parentId: proposal.parentId,
        label: proposal.suggestedLabel,
        scope: proposal.suggestedScope,
      })
    },
    async dismissSplit() {},
    async confirmUpdate() {},
    async dismissUpdate() {},
  }

  const config: StelloAgentConfig = {
    sessions,
    memory,
    session: {
      sessionResolver: async (sessionId) => {
        const entry = sessionMap.get(sessionId)
        if (!entry) throw new Error(`Unknown session: ${sessionId}`)
        if ('main' in entry && entry.main) {
          return wrapMainSession(sessionId, entry.main)
        }
        return wrapStandardSession(sessionId, entry.session, memory)
      },
      mainSessionResolver: async () => ({
        async integrate(fn) {
          const result = await mainSession.integrate(fn) as {
            synthesis: string
            insights: Array<{ sessionId: string; content: string }>
          } | null
          if (result) {
            await memory.writeMemory(rootId, result.synthesis)
            for (const insight of result.insights) {
              await memory.writeScope(insight.sessionId, insight.content)
            }
          }
          return result
        },
      }),
      consolidateFn(currentMemory, messages) {
        return createDefaultConsolidateFn(currentConsolidatePrompt, llmCall)(currentMemory, messages)
      },
      integrateFn(children, currentSynthesis) {
        return createDefaultIntegrateFn(currentIntegratePrompt, llmCall)(children, currentSynthesis)
      },
    },
    capabilities: {
      lifecycle,
      tools,
      skills: skillRouter,
      confirm,
    },
    orchestration: {
      scheduler,
      hooks: {
        onRoundStart({ sessionId }) {
          currentToolSessionId = sessionId
        },
        onRoundEnd({ sessionId, input, turn }) {
          currentToolSessionId = null
          const userRecord = { role: 'user' as const, content: input, timestamp: new Date().toISOString() }
          const assistantRecord = { role: 'assistant' as const, content: turn.finalContent ?? turn.rawResponse, timestamp: new Date().toISOString() }
          lifecycle.afterTurn(sessionId, userRecord, assistantRecord).catch(() => {})
        },
      },
    },
  }

  const agent = createStelloAgent(config)

  return {
    agent,
    async startDevtools(options = {}) {
      return startDevtools(agent, {
        port: options.port,
        open: options.open ?? false,
        llm: {
          getConfig() {
            return { ...currentLlmConfig }
          },
          setConfig(nextConfig) {
            const newLlm = createOpenAICompatibleAdapter({
              apiKey: nextConfig.apiKey ?? currentLlmConfig.apiKey,
              baseURL: nextConfig.baseURL,
              model: nextConfig.model,
            })
            currentLlmConfig = {
              model: nextConfig.model,
              baseURL: nextConfig.baseURL,
              apiKey: nextConfig.apiKey ?? currentLlmConfig.apiKey,
              temperature: nextConfig.temperature ?? currentLlmConfig.temperature,
              maxTokens: nextConfig.maxTokens ?? currentLlmConfig.maxTokens,
            }
            currentLlm = newLlm
            for (const entry of sessionMap.values()) {
              const session = 'main' in entry && entry.main ? entry.main : entry.session
              session.setLLM(newLlm)
            }
            persistDevtoolsState(stateStore, {
              llm: currentLlmConfig,
              prompts: { consolidate: currentConsolidatePrompt, integrate: currentIntegratePrompt },
              disabledTools: [...disabledTools],
              disabledSkills: [...disabledSkills],
            }).catch(() => {})
          },
        },
        prompts: {
          getPrompts() {
            return { consolidate: currentConsolidatePrompt, integrate: currentIntegratePrompt }
          },
          setPrompts(prompts) {
            if (prompts.consolidate) currentConsolidatePrompt = prompts.consolidate
            if (prompts.integrate) currentIntegratePrompt = prompts.integrate
            persistDevtoolsState(stateStore, {
              llm: currentLlmConfig,
              prompts: { consolidate: currentConsolidatePrompt, integrate: currentIntegratePrompt },
              disabledTools: [...disabledTools],
              disabledSkills: [...disabledSkills],
            }).catch(() => {})
          },
        },
        sessionAccess: {
          async getSystemPrompt(sessionId) {
            const entry = sessionMap.get(sessionId)
            if (!entry) return null
            const session = 'main' in entry && entry.main ? entry.main : entry.session
            return session.systemPrompt()
          },
          async setSystemPrompt(sessionId, content) {
            const entry = sessionMap.get(sessionId)
            if (!entry) return
            const session = 'main' in entry && entry.main ? entry.main : entry.session
            await session.setSystemPrompt(content)
            await writePersistedSystemPrompt(fs, sessionId, content)
          },
          async getScope(sessionId) {
            const entry = sessionMap.get(sessionId)
            if (!entry || ('main' in entry && entry.main)) return null
            return entry.session.insight()
          },
          async setScope(sessionId, content) {
            const entry = sessionMap.get(sessionId)
            if (!entry || ('main' in entry && entry.main)) return
            await entry.session.setInsight(content)
            await syncSessionScopeMirror(sessionId, entry.session, memory)
          },
          async injectRecord(sessionId, record) {
            await memory.appendRecord(sessionId, {
              role: record.role as TurnRecord['role'],
              content: record.content,
              timestamp: new Date().toISOString(),
            })
          },
        },
        tools: {
          getTools() {
            return allToolDefs.map((tool) => ({ ...tool, enabled: !disabledTools.has(tool.name) }))
          },
          setEnabled(name, enabled) {
            if (enabled) disabledTools.delete(name)
            else disabledTools.add(name)
            persistDevtoolsState(stateStore, {
              llm: currentLlmConfig,
              prompts: { consolidate: currentConsolidatePrompt, integrate: currentIntegratePrompt },
              disabledTools: [...disabledTools],
              disabledSkills: [...disabledSkills],
            }).catch(() => {})
          },
        },
        skills: {
          getSkills() {
            return baseSkillRouter.getAll().map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: !disabledSkills.has(skill.name),
            }))
          },
          setEnabled(name, enabled) {
            if (enabled) disabledSkills.delete(name)
            else disabledSkills.add(name)
            persistDevtoolsState(stateStore, {
              llm: currentLlmConfig,
              prompts: { consolidate: currentConsolidatePrompt, integrate: currentIntegratePrompt },
              disabledTools: [...disabledTools],
              disabledSkills: [...disabledSkills],
            }).catch(() => {})
          },
        },
        integration: {
          async trigger() {
            const resolvedMain = await config.session?.mainSessionResolver?.()
            if (!resolvedMain || !config.session?.integrateFn) {
              throw new Error('MainSession is not configured')
            }
            const result = await resolvedMain.integrate(config.session.integrateFn) as {
              synthesis: string
              insights: Array<{ sessionId: string; content: string }>
            } | null
            return {
              synthesis: result?.synthesis ?? '',
              insightCount: result?.insights.length ?? 0,
            }
          },
        },
      } as Parameters<typeof startDevtools>[1])
    },
  }
}
