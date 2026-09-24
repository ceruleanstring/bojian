'use strict';
// 籠子的預載（ADR-009 第 3 點）：Node 的權限鎖（--permission）不管網路（v24 沒有 --allow-net），
// 所以由 cage.mjs 用 -r 把這支先載進工人寫的程式，把所有連網入口換成丟錯。
// 這是「換掉入口」的軟擋——對 AI 寫出來的普通程式有效，不是對付有心人的防線（真正的防線是 ADR-004／US-053 那三道閘）。
// CommonJS：-r 只吃 CJS；工人的 ESM 腳本 import 'node:https' 拿到的也是同一個模組物件，一樣被換掉。
// 實測（2026-09-23）：不能把 net.Socket 整個類別換掉——Node 自己的 stdout／stderr 管線就是 new net.Socket，
// 換掉整個行程連 console.log 都炸。所以類別留著、把「發出連線」的方法（Socket.prototype.connect 等）換掉。

const MSG = '這一步不准連網（剝繭籠子）';

function blocked() {
  const e = new Error(MSG);
  e.code = 'BOJIAN_CAGE_NO_NET';
  throw e;
}

function replace(obj, key) {
  if (!obj) return;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) return;
    Object.defineProperty(obj, key, { value: blocked, writable: true, configurable: true, enumerable: desc.enumerable });
  } catch { /* 蓋不動就算 */ }
}

// 模組頂層所有小寫開頭的函式（connect／request／get／lookup／createServer…）全換掉；isIP 這類純判斷留著
const KEEP = new Set(['isIP', 'isIPv4', 'isIPv6', 'validateHeaderName', 'validateHeaderValue', 'getDefaultAutoSelectFamily', 'getDefaultAutoSelectFamilyAttemptTimeout', 'getDefaultResultOrder', 'getDefaultHighWaterMark', 'setDefaultHighWaterMark']);
function neuterFunctions(obj) {
  if (!obj) return;
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (KEEP.has(key)) continue;
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(obj, key); } catch { continue; }
    if (desc && typeof desc.value === 'function' && /^[a-z_]/.test(key)) replace(obj, key);
  }
}

const load = (name) => { try { return require(`node:${name}`); } catch { return null; } };

const net = load('net');
if (net) {
  neuterFunctions(net);
  replace(net.Socket?.prototype, 'connect');
  replace(net.Server?.prototype, 'listen');
  replace(net, 'BlockList');
  replace(net, 'SocketAddress');
}

const tls = load('tls');
if (tls) {
  neuterFunctions(tls);
  replace(tls, 'TLSSocket');
  replace(tls, 'Server');
}

for (const name of ['http', 'https']) {
  const m = load(name);
  if (!m) continue;
  neuterFunctions(m);
  replace(m, 'ClientRequest');
  replace(m, 'Server');
  replace(m.Agent?.prototype, 'createConnection');
  replace(m.Agent?.prototype, 'addRequest');
  replace(m.globalAgent, 'createConnection');
  replace(m.globalAgent, 'addRequest');
}

const http2 = load('http2');
if (http2) {
  neuterFunctions(http2);
  replace(http2, 'Http2ServerRequest');
  replace(http2, 'Http2ServerResponse');
}

const dns = load('dns');
if (dns) {
  neuterFunctions(dns);
  neuterFunctions(dns.promises);
  replace(dns, 'Resolver');
  replace(dns.promises, 'Resolver');
}

const dgram = load('dgram');
if (dgram) {
  neuterFunctions(dgram);
  replace(dgram, 'Socket');
}

// 全域入口：fetch／WebSocket
for (const g of ['fetch', 'WebSocket']) {
  try { Object.defineProperty(globalThis, g, { value: blocked, writable: false, configurable: false, enumerable: false }); } catch { /* 略過 */ }
}
