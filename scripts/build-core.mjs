import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: [
    'src/core/html2md.ts',
    'src/core/weread.ts',
    'src/core/paging.ts',
    'src/core/skill-pack.ts',
    'src/core/svg-slices.ts',
    'src/core/reel.ts',
    'src/core/green-book.ts',
  ],
  bundle: true,
  format: 'esm',
  target: 'node18',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
});
