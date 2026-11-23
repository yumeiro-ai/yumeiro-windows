// 在 `npx cap add android` 之后运行：补上权限、允许局域网 http、换成 Yumeiro 图标。可重复运行。
const fs = require('fs');
const path = require('path');
const root = __dirname;
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
const manifestFile = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifestFile)) { console.error('找不到 android 工程，请先运行：npx cap add android'); process.exit(1); }
let xml = fs.readFileSync(manifestFile, 'utf8');
for (const permission of ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS']) {
  if (!xml.includes(permission)) xml = xml.replace('</manifest>', '    <uses-permission android:name="' + permission + '" />\n</manifest>');
}
// 自己部署在局域网里的服务器常常是 http；允许明文连接（公网请用 https）
if (!xml.includes('usesCleartextTraffic')) xml = xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
fs.writeFileSync(manifestFile, xml);
const icons = path.join(root, 'assets');
if (fs.existsSync(icons)) {
  for (const dir of fs.readdirSync(icons)) {
    if (!dir.startsWith('mipmap-')) continue;
    fs.mkdirSync(path.join(res, dir), { recursive: true });
    for (const file of fs.readdirSync(path.join(icons, dir))) fs.copyFileSync(path.join(icons, dir, file), path.join(res, dir, file));
  }
  fs.rmSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true }); // 去掉默认自适应图标，改用上面的图标
}
console.log('已处理：权限、明文连接、图标');
