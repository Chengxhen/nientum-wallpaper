// 把服务器源码打包成单文件代理（NientumBridge.exe 内嵌的资源）。
//
// 原版 @neteasecloudmusicapienhanced/api 会动态遍历 module 目录加载 200+ 接口，
// 单文件打包后无法定位；这里用 api-shim.js 静态映射实际用到的接口，
// 并 stub 掉反作弊 jsdom 与跨平台解锁逻辑，缩小体积、加快启动。
//
// 用法：
//   npm install
//   npm run bundle
//
// 产物：
//   payload/proxy/server.js        （esbuild 打包后的单文件）
//   payload/proxy/we_record_window.ps1
//   payload/data/china_ip_ranges.txt
//
// 之后把上述文件 gzip 成 .gz，再按 bridge/NientumBridge.cs 头部的 csc 命令
// 作为 -resource 嵌入即可。

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = __dirname;
const shimDir = path.join(root, 'shims');
const buildDir = path.join(root, 'build');
const payloadDir = path.join(root, 'payload');

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'proxy'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'data'), { recursive: true });

for (const f of ['api-shim.js', 'generateConfig-shim.js', 'checktoken-stub.js', 'unblockmusic-stub.js']) {
  fs.copyFileSync(path.join(shimDir, f), path.join(buildDir, f));
}

let serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
serverSrc = serverSrc.replace(
  "const api = require('@neteasecloudmusicapienhanced/api');",
  "const api = require('./api-shim.js');"
);
serverSrc = serverSrc.replace(
  "const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig');",
  "const generateConfig = require('./generateConfig-shim.js');"
);
fs.writeFileSync(path.join(buildDir, 'server-src.js'), serverSrc, 'utf8');

const stubPlugin = {
  name: 'nientum-stubs',
  setup(build) {
    const stubs = [
      { filter: /register_checktoken_v2(?:\.js)?$/, file: 'checktoken-stub.js' },
      { filter: /register_checktoken_v3(?:\.js)?$/, file: 'checktoken-stub.js' },
      { filter: /unblockmusic-utils$/, file: 'unblockmusic-stub.js' }
    ];
    for (const s of stubs) {
      build.onResolve({ filter: s.filter }, () => ({ path: path.join(buildDir, s.file) }));
    }
  }
};

esbuild.build({
  entryPoints: [path.join(buildDir, 'server-src.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  absWorkingDir: buildDir,
  nodePaths: [path.join(root, 'node_modules')],
  outfile: path.join(payloadDir, 'proxy', 'server.js'),
  plugins: [stubPlugin],
  logLevel: 'info',
  legalComments: 'none'
}).then(() => {
  const apiRoot = path.join(root, 'node_modules', '@neteasecloudmusicapienhanced', 'api');
  fs.copyFileSync(path.join(apiRoot, 'data', 'china_ip_ranges.txt'), path.join(payloadDir, 'data', 'china_ip_ranges.txt'));
  fs.copyFileSync(path.join(root, 'we_record_window.ps1'), path.join(payloadDir, 'proxy', 'we_record_window.ps1'));
  const st = fs.statSync(path.join(payloadDir, 'proxy', 'server.js'));
  console.log('proxy bundle ready: ' + (st.size / 1048576).toFixed(2) + ' MB');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});