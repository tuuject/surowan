import { defineConfig } from 'rolldown';

// 发布产物必须自包含。`@surowan/admin-surface` 是 private workspace 包，只要它的名字
// 出现在发布 manifest 的 `dependencies` 或 `bundledDependencies` 里，bun 就会绕过
// tarball 内的副本去 registry 解析同名包并拿到 404（bun 1.4.0 实测；issue #27418）。
// 因此这里把它整个打进 dist/bin.js，发布 manifest 里没有任何运行时依赖。
export default defineConfig({
  input: 'src/bin.ts',
  platform: 'node',
  transform: { target: 'node24' },
  output: {
    dir: 'dist',
    entryFileNames: 'bin.js',
    format: 'esm',
    codeSplitting: false,
    cleanDir: true,
  },
});
