import 'dotenv/config'
import { appSpec } from './app-spec.js'
import { createTemplateApp } from './bootstrap.js'

/** 启动模板应用并按需打开 DevTools。 */
async function main(): Promise<void> {
  const apiKey = process.env[appSpec.llm.apiKeyEnv]
  if (!apiKey) {
    console.error(`Missing ${appSpec.llm.apiKeyEnv}`)
    console.error(`  export OPENAI_BASE_URL=${appSpec.llm.baseURL}`)
    console.error(`  export ${appSpec.llm.apiKeyEnv}=your_key`)
    console.error(`  export OPENAI_MODEL=${appSpec.llm.model}`)
    process.exit(1)
  }

  const app = await createTemplateApp(appSpec)

  if (process.env.DEMO_DRY_RUN === '1') {
    console.log('Bootstrap succeeded.')
    return
  }

  const devtoolsPort = Number(process.env.DEVTOOLS_PORT ?? 4800)
  const devtools = await app.startDevtools({ port: devtoolsPort, open: false })

  console.log(`\n${appSpec.appName}`)
  console.log(`  Model:    ${process.env.OPENAI_MODEL ?? appSpec.llm.model}`)
  console.log(`  Base URL: ${process.env.OPENAI_BASE_URL ?? appSpec.llm.baseURL}`)
  console.log(`  DevTools: http://${appSpec.host ?? '127.0.0.1'}:${devtools.port}`)
  console.log('\n  Try: help me break this work into child sessions for different directions.\n')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
