'use strict';
// Links are bookmarks only. No network requests or parsing of third-party pages.
function normalize(value, message) {
  const fail = () => { throw new Error(message || '请填写有效的 HTTP/HTTPS 链接。'); };
  if (typeof URL !== 'undefined') {
    let parsed;
    try { parsed = new URL(value); } catch (_) { return fail(); }
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.href.length > 2048) return fail();
    return parsed.href;
  }
  // WeChat JSCore does not guarantee WHATWG URL. Accept conventional DNS/IPv4/IPv6 bookmarks.
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?([/?#].*)?$/i.exec(value);
  if (!match) return fail();
  let host = match[2].toLowerCase();
  if (host[0] === '[') {
    const inner = host.slice(1,-1);
    const halves = inner.split('::');
    if (halves.length > 2 || inner.includes(':::') || (inner[0] === ':' && !inner.startsWith('::')) || (inner.endsWith(':') && !inner.endsWith('::')) || !/^[a-f\d:]+$/.test(inner)) return fail();
    const groups = inner.split(':').filter(Boolean);
    if (groups.some(group => group.length > 4) || (halves.length === 1 ? groups.length !== 8 : groups.length >= 8)) return fail();
  } else {
    if (host.length > 253 || host.split('.').some((label,index,all) => (!label && index !== all.length-1) || label.length > 63 || /^-|-$/.test(label))) return fail();
    if (/^[\d.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(n=>!/^\d{1,3}$/.test(n)||Number(n)>255))) return fail();
  }
  const protocol = match[1].toLowerCase(), port = match[3];
  if (port && Number(port) > 65535) return fail();
  let suffix = match[4] || '/';
  if (suffix[0] !== '/') suffix = '/' + suffix;
  const split = suffix.search(/[?#]/), pathname = split < 0 ? suffix : suffix.slice(0,split), tail = split < 0 ? '' : suffix.slice(split);
  const segments = [];
  for (const segment of pathname.split('/').slice(1)) {
    const dot = segment.replace(/%2e/ig,'.');
    if (dot === '..') segments.pop();
    else if (dot !== '.') segments.push(segment);
  }
  if (/\/(?:\.|%2e|\.\.|\.%2e|%2e\.|%2e%2e)$/i.test(pathname)) segments.push('');
  let result = protocol+'://'+host+(port && !((protocol==='https'&&Number(port)===443)||(protocol==='http'&&Number(port)===80))?':'+Number(port):'')+'/'+segments.join('/')+tail;
  try { result = result.replace(/[^\x21-\x7e]+/g, char=>encodeURIComponent(char)); } catch (_) { return fail(); }
  if (result.length>2048) return fail();
  return result;
}
module.exports = {normalize};
