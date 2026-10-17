import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 本地复现 Obsidian 社区扫描器的 type-checked 规则集。
 * 社区用的是 typescript-eslint 的 recommendedTypeChecked，
 * 这里对齐同一套，好让本地 lint 结果和社区页面一致。
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 只关心社区会报的三类
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // 这条在 Obsidian 插件里天然会撞（DOM 类型）
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
