// Nientum 壁纸不启用 unblock（跨平台解锁）功能，这里提供最小占位，
// 避免把 jsdom 等 10MB+ 的无用依赖打进代理内核。
module.exports = {
  async matchID() {
    throw new Error('unblock disabled in Nientum build');
  }
};