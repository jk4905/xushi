'use strict';

const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { networkInterfaces } = require('node:os');
const { join } = require('node:path');

function createHandler(html, model = readFileSync(join(__dirname, 'weekend-household-model.js')), css = readFileSync(join(__dirname, 'weekend-menu-c.css'))) {
  const seed = readFileSync(join(__dirname, 'weekend-household-seed.js'));
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('仅支持打开清单。');
      return;
    }
    const pathname = (request.url || '').split('?')[0];
    if (!['/', '/weekend-menu-prototype.html', '/weekend-household-model.js', '/weekend-household-seed.js', '/weekend-menu-c.css'].includes(pathname)) {
      response.writeHead(404);
      response.end(request.method === 'HEAD' ? undefined : '页面不存在。');
      return;
    }
    const seedScript = pathname === '/weekend-household-seed.js';
    const script = pathname === '/weekend-household-model.js' || seedScript;
    const style = pathname === '/weekend-menu-c.css';
    response.writeHead(200, { 'Content-Type': script ? 'application/javascript; charset=utf-8' : style ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : seedScript ? seed : script ? model : style ? css : html);
  };
}

if (require.main === module) {
  try {
    const address = Object.entries(networkInterfaces())
      .filter(([name]) => /^en\d+$/.test(name))
      .flatMap(([, interfaces]) => interfaces || [])
      .find(entry => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address));
    if (!address) throw new Error('未找到局域网地址，请让 Mac 与 iPhone 接入同一 Wi-Fi。');
    const html = readFileSync(join(__dirname, 'weekend-menu-prototype.html'));
    const server = createServer(createHandler(html));
    server.on('error', error => {
      console.error(`手机入口未启动：${error.code || error.message}。请检查端口 8765 和终端网络权限。`);
      process.exitCode = 1;
    });
    server.listen(8765, address.address, () => {
      console.log(`在同一 Wi-Fi 的 iPhone Safari 打开：http://${address.address}:8765/weekend-menu-prototype.html`);
      console.log('Mac 需保持开机、终端保持运行；按 Control-C 停止。仅提供原型与固定脚本，手机上的改动不会传回 Mac。');
    });
  } catch (error) {
    console.error(`手机入口未启动：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createHandler };
