import { defineConfig } from '@playwright/test'

export default defineConfig({
    workers: 1,
    // Give failing tests a second chance
    retries: 2,
    testDir: 'test/e2e',
    timeout: 25000,
    expect: {
        timeout: 5000,
    },
})
