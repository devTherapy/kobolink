// Extends the root flat config. NestJS leans on decorators and DI, which the
// base type-checked rule set does not otherwise expect.
import rootConfig from '../../eslint.config.mjs'
import tseslint from 'typescript-eslint'

export default tseslint.config(...rootConfig, {
  // Scoped to TS so this does not fight the root config's
  // disableTypeChecked override for plain config files (this file itself
  // included) — type-aware parsing needs a real tsconfig project, which
  // eslint.config.mjs is deliberately excluded from.
  files: ['**/*.ts'],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    // Nest injects providers through empty constructors and interface-only
    // parameter types; neither implies dead code.
    '@typescript-eslint/no-extraneous-class': 'off',
    // Decorated classes commonly have no non-decorator members.
    '@typescript-eslint/no-unsafe-declaration-merging': 'off',
  },
})
