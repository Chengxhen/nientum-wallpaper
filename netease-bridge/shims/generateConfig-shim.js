// 原 generateConfig 经由 ./main 动态加载器引入全部接口，打包后会拖入整个 module 目录。
// 这里保持原有三步（游客 token / xeapi 公钥 / neapi 密钥）逻辑，仅把依赖改为静态引入。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cookieToJson, generateRandomChineseIP } = require('@neteasecloudmusicapienhanced/api/util/index');
const api = require('./api-shim.js');
const { getXeapiPublicKey } = require('@neteasecloudmusicapienhanced/api/util/xeapiKey');
const { loadNeapiKey } = require('@neteasecloudmusicapienhanced/api/util/neapiKey');
const registerNeapikey = require('@neteasecloudmusicapienhanced/api/module/register_neapikey');
const tmpPath = os.tmpdir();

async function generateConfig() {
  global.cnIp = generateRandomChineseIP();
  try {
    const res = await api.register_anonimous();
    const cookie = res.body.cookie;
    if (cookie) {
      const cookieObj = cookieToJson(cookie);
      fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), cookieObj.MUSIC_A, 'utf-8');
    }
  } catch (error) {
    console.log(error);
  }
  try {
    let currentPublicKey = {};
    try {
      currentPublicKey = JSON.parse(fs.readFileSync(path.resolve(tmpPath, 'xeapi_public_key'), 'utf-8'));
    } catch (_) {}
    const publicKey = await getXeapiPublicKey(currentPublicKey, global.deviceId);
    fs.writeFileSync(path.resolve(tmpPath, 'xeapi_public_key'), JSON.stringify(publicKey), 'utf-8');
  } catch (error) {
    console.log(error);
  }
  try {
    const current = loadNeapiKey();
    await registerNeapikey(
      {
        version: current ? current.version : 0,
        behavior: current ? 'update' : 'open'
      },
      null
    );
  } catch (error) {
    console.log(error);
  }
}

module.exports = generateConfig;