import { defineConfig } from 'vitest/config'

const configuredTimeout = Number(process.env.URTEXT_TEST_TIMEOUT_MS)
const testTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000

export default defineConfig({
  test: { testTimeout },
})
