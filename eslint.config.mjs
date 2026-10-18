import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

/**
 * 对齐 Obsidian 社区扫描器：使用官方 eslint-plugin-obsidianmd 的 recommended 配置。
 * 本地 lint 结果应与 community.obsidian.md 后台 Review 的 SOURCE CODE 一节一致。
 */
export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.*'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['main.js', 'dist/**', 'node_modules/**', 'qa-vault/**', 'scripts/**', 'tests/**'],
  },
]);
