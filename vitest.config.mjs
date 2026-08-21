import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.spec.ts',
      'src/dsh-codeaudit/tests/**/*.spec.ts',
      'src/dsh-client-ui-codeaudit/tests/**/*.spec.ts',
      'src/dsh-client-ui-codeaudit/tests/**/*.spec.tsx',
    ],
    environment: 'node',
  },
})
