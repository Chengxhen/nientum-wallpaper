// Nientum 只使用无需 X-antiCheatToken 的 11 个接口；
// 浏览器端 Watchman 反作弊（jsdom 4MB+）不参与，占位避免把 jsdom 打进包内。
module.exports = {
  async getToken() {
    throw new Error('anti-cheat token is not used by Nientum endpoints');
  }
};