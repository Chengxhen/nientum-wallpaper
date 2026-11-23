// 只静态引入 Nientum 壁纸实际用到的网易云接口。
// 原包 main.js 会遍历 module 目录动态 require 全部 200+ 接口，单一文件打包后无法定位，
// 这里改为静态映射，启动更快、依赖更小，接口行为与原包装配逻辑一致。
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpPath = os.tmpdir();
const anonymousTokenPath = path.resolve(tmpPath, 'anonymous_token');
try {
  if (!fs.existsSync(anonymousTokenPath)) fs.writeFileSync(anonymousTokenPath, '', 'utf-8');
} catch (_) {}

const request = require('@neteasecloudmusicapienhanced/api/util/request');
const { cookieToJson } = require('@neteasecloudmusicapienhanced/api/util');

const modules = {
  cloudsearch: require('@neteasecloudmusicapienhanced/api/module/cloudsearch.js'),
  login_qr_check: require('@neteasecloudmusicapienhanced/api/module/login_qr_check.js'),
  login_qr_create: require('@neteasecloudmusicapienhanced/api/module/login_qr_create.js'),
  login_qr_key: require('@neteasecloudmusicapienhanced/api/module/login_qr_key.js'),
  login_status: require('@neteasecloudmusicapienhanced/api/module/login_status.js'),
  like: require('@neteasecloudmusicapienhanced/api/module/like.js'),
  likelist: require('@neteasecloudmusicapienhanced/api/module/likelist.js'),
  lyric: require('@neteasecloudmusicapienhanced/api/module/lyric.js'),
  playlist_track_all: require('@neteasecloudmusicapienhanced/api/module/playlist_track_all.js'),
  recommend_songs: require('@neteasecloudmusicapienhanced/api/module/recommend_songs.js'),
  register_anonimous: require('@neteasecloudmusicapienhanced/api/module/register_anonimous.js'),
  song_url: require('@neteasecloudmusicapienhanced/api/module/song_url.js'),
  song_url_v1: require('@neteasecloudmusicapienhanced/api/module/song_url_v1.js'),
  user_playlist: require('@neteasecloudmusicapienhanced/api/module/user_playlist.js')
};

const api = {};
for (const name of Object.keys(modules)) {
  const fileModule = modules[name];
  api[name] = function (data = {}) {
    const cookie = typeof data.cookie === 'string' ? cookieToJson(data.cookie) : (data.cookie || {});
    return fileModule(Object.assign({}, data, { cookie }), (...args) => request(...args));
  };
}

module.exports = api;