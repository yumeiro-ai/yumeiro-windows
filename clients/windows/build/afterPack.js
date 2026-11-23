// electron-builder 在这台机器上自带的 rcedit 步骤会失败（“Unable to commit changes”），所以关掉它（signAndEditExecutable=false），
// 改在打包后用同一个缓存里的 rcedit 直接给 Yumeiro.exe 写入图标和版本信息。找不到 rcedit 时不中断打包，只提示。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function findRcedit() {
  const roots = [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'winCodeSign')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).sort().reverse()) {
      const exe = path.join(root, dir, 'rcedit-x64.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
  const rcedit = findRcedit();
  if (!rcedit || !fs.existsSync(exe) || !fs.existsSync(icon)) { console.warn('  • 没有找到 rcedit 或图标，exe 将使用默认图标'); return; }
  const version = context.packager.appInfo.version;
  // 刚写完的 188 MB exe 会被杀毒软件扫描、短时间内被占用，写资源会报 “Unable to commit changes”；等一会儿重试即可
  const args = [exe, '--set-icon', icon, '--set-file-version', version, '--set-product-version', version + '.0',
    '--set-version-string', 'FileDescription', 'Yumeiro desktop client', '--set-version-string', 'ProductName', 'Yumeiro',
    '--set-version-string', 'InternalName', 'Yumeiro', '--set-version-string', 'CompanyName', 'Yumeiro', '--set-version-string', 'LegalCopyright', 'Yumeiro'];
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try { execFileSync(rcedit, args, { stdio: 'pipe' }); lastError = null; break; }
    catch (error) { lastError = error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); }
  }
  if (lastError) throw new Error('写入 exe 图标失败（已重试 12 次）：' + String(lastError.stderr || lastError.message).trim());
  console.log('  • 已写入 exe 图标与版本信息：' + path.basename(exe));
};
