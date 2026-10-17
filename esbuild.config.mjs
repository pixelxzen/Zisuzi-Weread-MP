import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  banner: {
    js: '/* Bundled by esbuild — source: github.com/pixelxzen/obsidian-weread-mp */',
  },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
  format: 'cjs',
  target: 'es2021',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
