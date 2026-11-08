'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const inputFiles = ['weekend-menu-prototype.html', 'weekend-household-model.js', 'weekend-menu-phone.cjs', 'weekend-menu-c.css'];
const inputHashes = () => Object.fromEntries(inputFiles.map(file => [file, createHash('sha256').update(readFileSync(join(__dirname, file))).digest('hex')]));
const initialHashes = inputHashes();

let passed = 0, failures = 0;

function check(name, action) {
  try {
    action();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message.slice(0, 1200)}\n${error.stack?.split('\n').find(line => line.includes('check.cjs:')) || ''}`);
  }
}

async function run() {
  const filename = join(__dirname, 'weekend-menu-prototype.html');
  let html;
  try {
    html = readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`HTML 尚未生成：${filename}`);
    throw error;
  }
  const scripts = [...html.matchAll(/<script\b(?=[^>]*\bid\s*=\s*["']meal-logic["'])[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  const { createHandler } = require('./weekend-menu-phone.cjs');
  const handle = createHandler(Buffer.from(html));
  const request = (method, url) => {
    const result = { headers: {} };
    handle({ method, url }, {
      setHeader: (name, value) => { result.headers[name] = value; },
      writeHead: (status, headers = {}) => { result.status = status; Object.assign(result.headers, headers); },
      end: body => { result.body = body; },
    });
    return result;
  };
  check('手机入口只返回采购页面且不缓存', () => {
    for (const url of ['/', '/weekend-menu-prototype.html', '/weekend-menu-prototype.html?source=phone']) {
      const result = request('GET', url);
      assert.equal(result.status, 200);
      assert.equal(result.body.toString(), html);
      assert.equal(result.headers['Cache-Control'], 'no-store');
      assert.equal(result.headers['Content-Type'], 'text/html; charset=utf-8');
      assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    }
  });
  check('手机入口的 HEAD 不返回正文', () => {
    assert.equal(request('HEAD', '/').status, 200);
    assert.equal(request('HEAD', '/').body, undefined);
    assert.equal(request('HEAD', '/不存在').status, 404);
    assert.equal(request('HEAD', '/不存在').body, undefined);
  });
  check('手机入口仅允许固定模型 JS，GET 内容及 HEAD 类型正确', () => {
    const source = readFileSync(join(__dirname, 'weekend-household-model.js'), 'utf8');
    for (const url of ['/weekend-household-model.js', '/weekend-household-model.js?v=2']) {
      const result = request('GET', url), head = request('HEAD', url);
      assert.equal(result.status, 200);
      assert.equal(result.body.toString(), source);
      assert.equal(result.headers['Content-Type'], 'application/javascript; charset=utf-8');
      assert.equal(result.headers['Cache-Control'], 'no-store');
      assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(head.status, 200);
      assert.equal(head.body, undefined);
      assert.deepEqual(head.headers, result.headers);
    }
    for (const url of ['/other.js', '/weekend-household-model-check.cjs', '/nested/weekend-household-model.js', '/%77eekend-household-model.js']) {
      assert.equal(request('GET', url).status, 404);
      assert.equal(request('HEAD', url).status, 404);
      assert.equal(request('HEAD', url).body, undefined);
    }
    assert.equal(request('POST', '/weekend-household-model.js').status, 405);
  });
  check('手机入口仅提供固定 C CSS，查询参数与 HEAD 保留类型且拒绝路径变体', () => {
    const css = readFileSync(join(__dirname, 'weekend-menu-c.css'), 'utf8');
    for (const url of ['/weekend-menu-c.css', '/weekend-menu-c.css?v=c']) {
      const get = request('GET', url), head = request('HEAD', url);
      assert.equal(get.status, 200);
      assert.equal(get.body.toString(), css);
      assert.equal(get.headers['Content-Type'], 'text/css; charset=utf-8');
      assert.equal(get.headers['Cache-Control'], 'no-store');
      assert.equal(get.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(head.status, 200);
      assert.equal(head.body, undefined);
      assert.deepEqual(head.headers, get.headers);
      assert.equal(request('POST', url).status, 405);
    }
    for (const url of ['/other.css', '/nested/weekend-menu-c.css', '/%77eekend-menu-c.css', '/../weekend-menu-c.css']) {
      assert.equal(request('GET', url).status, 404);
      assert.equal(request('HEAD', url).status, 404);
    }
  });

  check('手机入口不暴露目录、研究文件或任意路径', () => {
    for (const url of ['/weekend-menu-iphone.md', '/weekend-menu-phone.cjs', '/../MEMORY.md', '/%2e%2e/secret', '/.git/config', '/index.html', 'http://example.com/', '']) {
      const result = request('GET', url);
      assert.equal(result.status, 404);
      assert.equal(result.body, '页面不存在。');
    }
  });
  check('手机入口拒绝写操作', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const result = request(method, '/');
      assert.equal(result.status, 405);
      assert.equal(result.headers.Allow, 'GET, HEAD');
    }
  });
  assert.equal(scripts.length, 1, '必须恰有一个 script#meal-logic');
  const context = vm.createContext({ URL });
  vm.runInContext(scripts[0][1], context, { filename, timeout: 1000 });
  const model = context.MealModel;
  assert.ok(model, 'meal-logic 必须暴露 context.MealModel');
  for (const method of ['createState', 'updateItem', 'setReviewed', 'setNotes', 'addItem', 'saveVersion', 'useVersion', 'summary', 'validate']) {
    assert.equal(typeof model[method], 'function', `缺少方法 ${method}`);
  }
  passed += 1;
  console.log('PASS 加载 meal-logic 与 MealModel 接口');

  const plain = value => JSON.parse(JSON.stringify(value));
  const fresh = () => model.createState();
  const item = (state, id) => {
    const found = state.items.find(entry => entry.id === id);
    assert.ok(found, `缺少配料 ${id}`);
    return found;
  };
  const invoke = (method, state, ...args) => {
    const before = JSON.stringify(state);
    let result;
    try {
      result = model[method](state, ...args);
    } finally {
      assert.equal(JSON.stringify(state), before, `${method} 改动了旧 state`);
    }
    if (method !== 'summary' && method !== 'validate') {
      assert.equal(model.validate(result), true, `${method} 产生了无效 state`);
    }
    return result;
  };
  const summary = state => invoke('summary', state);
  const complete = () => {
    let state = fresh();
    for (const id of state.items.map(entry => entry.id)) {
      state = invoke('updateItem', state, id, { choice: 'include', quantity: '1 份' });
      state = invoke('updateItem', state, id, { status: 'at-home' });
    }
    return invoke('setReviewed', state, true);
  };

  check('默认状态：19 行、14 include、5 pending、空用量', () => {
    const state = fresh();
    assert.deepEqual(Object.keys(state).sort(), ['items', 'notes', 'reviewed', 'versions']);
    assert.equal(state.items.length, 19);
    assert.equal(new Set(state.items.map(entry => entry.id)).size, 19);
    assert.equal(state.items.filter(entry => entry.choice === 'include').length, 14);
    assert.deepEqual(Array.from(state.items.filter(entry => entry.choice === 'pending'), entry => entry.id).sort(),
      ['beef-stock', 'fresh-tomato', 'parsley', 'rosemary', 'salt']);
    for (const entry of state.items) {
      assert.deepEqual(Object.keys(entry).sort(), ['choice', 'dish', 'id', 'name', 'note', 'quantity', 'source', 'status']);
      assert.equal(entry.quantity, '');
      assert.equal(entry.status, 'unchecked');
    }
    assert.equal(item(state, 'celery').choice, 'include');
    assert.equal(state.items.filter(entry => entry.id === 'bacon').length, 1);
    assert.equal(state.reviewed, false);
    assert.equal(state.notes, '');
    assert.deepEqual(plain(state.versions), []);
    assert.equal(invoke('validate', state), true);
    assert.equal(summary(state).ready, false);
  });

  check('summary 返回全部字段和可用计数', () => {
    const result = summary(fresh());
    assert.deepEqual(Object.keys(result).sort(),
      ['atHome', 'bought', 'missingQuantities', 'ready', 'required', 'toBuy', 'unchecked', 'unresolvedChoices']);
    for (const key of ['unresolvedChoices', 'missingQuantities', 'unchecked', 'toBuy', 'bought', 'atHome', 'required']) {
      assert.ok(Number.isInteger(result[key]) && result[key] >= 0, `${key} 应为非负整数`);
    }
    assert.equal(result.unresolvedChoices, 5);
    assert.equal(result.missingQuantities, 14);
    assert.equal(result.required, 14);
    assert.equal(result.ready, false);
  });

  check('填齐选择、用量、采购并核对后 ready', () => {
    assert.deepEqual(plain(summary(complete())), {
      unresolvedChoices: 0, missingQuantities: 0, unchecked: 0,
      toBuy: 0, bought: 0, atHome: 19, ready: true, required: 19,
    });
  });

  check('缺培根用量或未核对培根采购都会阻止 ready', () => {
    let state = invoke('updateItem', complete(), 'bacon', { quantity: '' });
    state = invoke('setReviewed', state, true);
    assert.equal(summary(state).missingQuantities, 1);
    assert.equal(summary(state).ready, false);
    state = invoke('updateItem', state, 'bacon', { quantity: '1 份' });
    state = invoke('setReviewed', state, true);
    assert.equal(summary(state).missingQuantities, 0);
    assert.equal(summary(state).unchecked, 1);
    assert.equal(summary(state).ready, false);
    state = invoke('updateItem', state, 'bacon', { status: 'bought' });
    assert.equal(summary(state).ready, true);
  });

  check('reviewed=false 或仍有 pending 时不能 ready', () => {
    const state = complete();
    assert.equal(summary(invoke('setReviewed', state, false)).ready, false);
    const pending = invoke('setReviewed', invoke('updateItem', state, 'fresh-tomato', { choice: 'pending' }), true);
    assert.equal(summary(pending).unresolvedChoices, 1);
    assert.equal(summary(pending).ready, false);
  });

  check('omit 项不计采购或缺量，也不阻止 ready', () => {
    let state = invoke('updateItem', complete(), 'celery', { choice: 'omit', quantity: '' });
    state = invoke('setReviewed', state, true);
    assert.equal(item(state, 'celery').status, 'unchecked');
    assert.deepEqual(plain(summary(state)), {
      unresolvedChoices: 0, missingQuantities: 0, unchecked: 0,
      toBuy: 0, bought: 0, atHome: 18, ready: true, required: 18,
    });
  });

  check('用量实际变化清本项采购状态，并要求重新核对', () => {
    const before = complete();
    const after = invoke('updateItem', before, 'bacon', { quantity: '2 份' });
    assert.equal(after.reviewed, false);
    assert.equal(item(after, 'bacon').status, 'unchecked');
    assert.equal(item(after, 'bacon').quantity, '2 份');
    assert.equal(item(after, 'celery').status, 'at-home');
    assert.equal(summary(after).ready, false);
    assert.equal(summary(before).ready, true);
  });

  check('选择实际变化清本项采购状态与 reviewed', () => {
    const state = invoke('updateItem', complete(), 'celery', { choice: 'omit', status: 'bought' });
    assert.equal(item(state, 'celery').choice, 'omit');
    assert.equal(item(state, 'celery').status, 'unchecked');
    assert.equal(state.reviewed, false);
  });

  check('choice 与 quantity 未变时保留采购确认和 reviewed', () => {
    const before = complete();
    const after = invoke('updateItem', before, 'bacon', { choice: 'include', quantity: '1 份' });
    assert.deepEqual(plain(after), plain(before));
  });

  check('单改 status 保留 reviewed，summary 区分四种采购状态', () => {
    let state = invoke('updateItem', complete(), 'bacon', { status: 'to-buy' });
    state = invoke('updateItem', state, 'celery', { status: 'bought' });
    state = invoke('updateItem', state, 'rosemary', { status: 'unchecked' });
    assert.equal(state.reviewed, true);
    assert.deepEqual(plain(summary(state)), {
      unresolvedChoices: 0, missingQuantities: 0, unchecked: 1,
      toBuy: 1, bought: 1, atHome: 16, ready: false, required: 19,
    });
    state = invoke('updateItem', state, 'rosemary', { status: 'bought' });
    assert.equal(summary(state).ready, false);
    state = invoke('updateItem', state, 'bacon', { status: 'at-home' });
    assert.equal(summary(state).ready, true);
  });

  check('setReviewed 只切换核对标记', () => {
    const before = complete();
    const after = invoke('setReviewed', before, false);
    assert.deepEqual(plain(after), { ...plain(before), reviewed: false });
    assert.deepEqual(plain(invoke('setReviewed', after, true)), plain(before));
  });

  check('不喜欢芹菜的备注不自动排除 celery', () => {
    const state = invoke('setNotes', fresh(), '我不喜欢芹菜；本次配方仍保留西芹。');
    assert.equal(state.notes, '我不喜欢芹菜；本次配方仍保留西芹。');
    assert.equal(item(state, 'celery').choice, 'include');
    assert.equal(item(fresh(), 'celery').choice, 'include');
  });

  check('updateItem 拒绝或忽略 choice/quantity/status 以外的字段', () => {
    const before = complete();
    const snapshot = JSON.stringify(before);
    let after;
    let rejected = false;
    try {
      after = model.updateItem(before, 'bacon', {
        id: 'replaced', name: '替换名称', dish: '替换菜品', source: '替换来源', note: '替换备注',
        reviewed: false, notes: '注入备注', versions: [],
      });
    } catch (error) {
      rejected = true;
    }
    assert.equal(JSON.stringify(before), snapshot, 'updateItem 改动了旧 state');
    if (!rejected) assert.deepEqual(plain(after), plain(before));
  });

  check('番茄膏与鲜番茄可独立选择和填写用量', () => {
    let state = fresh();
    const paste = state.items.find(entry => entry.id === 'tomato-paste' || /番茄膏|tomato[\s_-]*paste/i.test(entry.name));
    assert.ok(paste, '缺少可识别的番茄膏条目');
    assert.notEqual(paste.id, 'fresh-tomato');
    const before = plain(paste);
    state = invoke('updateItem', state, 'fresh-tomato', { choice: 'omit' });
    assert.deepEqual(plain(item(state, paste.id)), before);
    state = invoke('updateItem', state, paste.id, { quantity: '2 汤匙' });
    assert.equal(item(state, 'fresh-tomato').choice, 'omit');
    assert.equal(item(state, 'fresh-tomato').quantity, '');
    assert.equal(item(state, paste.id).quantity, '2 汤匙');
  });

  check('培根两个步骤合并 dish，保留单行并清采购确认', () => {
    let state = complete();
    const bacon = plain(item(state, 'bacon'));
    state = invoke('addItem', state, bacon.name, '第二步：炒香培根');
    state = invoke('addItem', state, bacon.name, '第三步：加入培根炖煮');
    assert.equal(state.items.length, 19);
    assert.equal(state.items.filter(entry => entry.id === 'bacon').length, 1);
    assert.equal(state.items.filter(entry => entry.name === bacon.name).length, 1);
    const merged = item(state, 'bacon');
    assert.ok(String(merged.dish).includes(String(bacon.dish)), '合并后丢失原菜品');
    assert.ok(String(merged.dish).includes('第二步：炒香培根'));
    assert.ok(String(merged.dish).includes('第三步：加入培根炖煮'));
    assert.equal(merged.quantity, bacon.quantity);
    assert.equal(merged.choice, bacon.choice);
    assert.equal(merged.status, 'unchecked');
    assert.equal(state.reviewed, false);
  });

  check('addItem 新行默认 include、空用量、unchecked', () => {
    const state = invoke('addItem', complete(), '试验配料', '周末加菜');
    assert.equal(state.items.length, 20);
    assert.equal(new Set(state.items.map(entry => entry.id)).size, 20);
    const added = state.items.find(entry => entry.name === '试验配料');
    assert.ok(added);
    assert.equal(added.choice, 'include');
    assert.equal(added.quantity, '');
    assert.equal(added.status, 'unchecked');
    assert.ok(String(added.dish).includes('周末加菜'));
    assert.equal(state.reviewed, false);
  });

  check('saveVersion 保存配方且保存项采购状态全部 unchecked', () => {
    const before = complete();
    const state = invoke('saveVersion', before, '周末配方');
    assert.equal(state.versions.length, 1);
    assert.deepEqual(plain(state.items), plain(before.items));
    const statuses = Array.from(JSON.stringify(state.versions).matchAll(/"status":"([^"]*)"/g), match => match[1]);
    assert.equal(statuses.length, state.items.length, '版本应保存所有配料的 status');
    assert.ok(statuses.every(status => status === 'unchecked'));
  });

  check('同名版本更新，异名版本新增', () => {
    let state = invoke('saveVersion', complete(), '周末配方');
    state = invoke('updateItem', state, 'bacon', { quantity: '2 份' });
    state = invoke('setNotes', state, '第二版备注');
    state = invoke('saveVersion', state, '周末配方');
    assert.equal(state.versions.length, 1);
    state = invoke('updateItem', state, 'bacon', { quantity: '3 份' });
    state = invoke('setNotes', state, '未保存的备注');
    state = invoke('useVersion', state, '周末配方');
    assert.equal(item(state, 'bacon').quantity, '2 份');
    assert.equal(state.notes, '第二版备注');
    assert.equal(state.reviewed, false);
    state = invoke('saveVersion', state, '下周配方');
    assert.equal(state.versions.length, 2);
  });

  check('复用版本恢复配方和西芹，不沿用已购买状态且保留 versions', () => {
    let state = invoke('setNotes', complete(), '不喜欢芹菜，但本版保留西芹');
    state = invoke('updateItem', state, 'celery', { status: 'bought' });
    state = invoke('setReviewed', state, true);
    const recipe = state.items.map(entry => ({ id: entry.id, choice: entry.choice, quantity: entry.quantity }));
    state = invoke('saveVersion', state, '保留西芹版');
    state = invoke('updateItem', state, 'celery', { choice: 'omit' });
    state = invoke('updateItem', state, 'bacon', { quantity: '9 份' });
    state = invoke('setNotes', state, '临时备注');
    const versions = plain(state.versions);
    state = invoke('useVersion', state, '保留西芹版');
    assert.deepEqual(plain(state.items.map(entry => ({ id: entry.id, choice: entry.choice, quantity: entry.quantity }))), plain(recipe));
    assert.equal(item(state, 'celery').choice, 'include');
    assert.equal(state.notes, '不喜欢芹菜，但本版保留西芹');
    assert.equal(state.reviewed, true);
    assert.ok(state.items.every(entry => entry.status === 'unchecked'));
    assert.deepEqual(plain(state.versions), versions);
    assert.equal(summary(state).unchecked, 19);
    assert.equal(summary(state).ready, false);
  });

  check('所有状态方法及读取方法不改旧 state', () => {
    let state = fresh();
    const history = [];
    for (const [method, ...args] of [
      ['updateItem', 'bacon', { quantity: '2 片' }], ['setReviewed', true],
      ['setNotes', '纯函数检查'], ['addItem', '独立配料', '加菜'],
      ['saveVersion', '纯函数版'], ['updateItem', 'celery', { choice: 'omit' }],
      ['useVersion', '纯函数版'],
    ]) {
      history.push([state, JSON.stringify(state)]);
      state = invoke(method, state, ...args);
    }
    summary(state);
    assert.equal(invoke('validate', state), true);
    for (const [previous, snapshot] of history) assert.equal(JSON.stringify(previous), snapshot);
    assert.equal(item(fresh(), 'bacon').quantity, '');
    assert.equal(fresh().versions.length, 0);
  });

  const invalid = [
    ['null', () => null], ['空对象', () => ({})], ['数组', () => []], ['字符串', () => 'state'],
    ['错误 choice', state => { state.items[0].choice = 'skip'; return state; }],
    ['错误 status', state => { state.items[0].status = 'done'; return state; }],
    ['重复 id', state => { state.items[1].id = state.items[0].id; return state; }],
    ['空 id', state => { state.items[0].id = ''; return state; }],
    ['空配料名', state => { state.items[0].name = ''; return state; }],
    ['缺 quantity', state => { delete state.items[0].quantity; return state; }],
    ['quantity 非字符串', state => { state.items[0].quantity = 2; return state; }],
    ['reviewed 非布尔', state => { state.reviewed = 'true'; return state; }],
    ['notes 非字符串', state => { state.notes = {}; return state; }],
    ['items 非数组', state => { state.items = {}; return state; }],
    ['versions 非数组', state => { state.versions = {}; return state; }],
    ['重复版本名', () => {
      const state = plain(invoke('saveVersion', fresh(), '重复版'));
      state.versions.push(plain(state.versions[0]));
      return state;
    }],
    ['超长 notes', state => { state.notes = '超'.repeat(100001); return state; }],
    ['过多配料', state => {
      state.items = Array.from({ length: 10001 }, (_, index) => ({ ...state.items[0], id: `overflow-${index}`, name: `配料${index}` }));
      return state;
    }],
  ];
  for (const field of ['id', 'name', 'dish', 'source', 'note', 'quantity']) {
    invalid.push([`超长 ${field}`, state => { state.items[0][field] = '超'.repeat(100001); return state; }]);
  }
  invalid.push(['超长版本名', () => {
    const state = plain(invoke('saveVersion', fresh(), '长度检查版'));
    state.versions[0].name = '超'.repeat(100001);
    return state;
  }]);
  for (const [name, corrupt] of invalid) {
    check(`非法导入被拒：${name}`, () => {
      assert.equal(invoke('validate', corrupt(plain(fresh()))), false);
    });
  }

  function loadPage(initial, options = {}) {
    const markup = options.html ?? html;
    // Legacy scenarios opt into a fixture; firstUse exercises genuinely absent storage.
    if (initial === undefined && !options.firstUse && !options.html) {
      const fixture = vm.createContext({ URL });
      vm.runInContext(html.match(/<script id="meal-logic">([\s\S]*?)<\/script>/)[1], fixture, { timeout: 1000 });
      initial = plain(fixture.MealModel.createState());
    }
    const handlers = new Map(), windowHandlers = new Map(), storage = new Map(), blobs = new Map(), downloads = [], confirmations = [], pointerCaptures = new Map();
    const session = new Map(Object.entries(options.session || {}));
    const legacyKey = 'weekend-menu-prototype-v1', householdKey = 'weekend-household-prototype-v2';
    const storageKey = options.household ? householdKey : legacyKey;
    if (initial !== undefined) storage.set(storageKey, typeof initial === 'string' ? initial : JSON.stringify(initial));
    if (options.legacy !== undefined) storage.set(legacyKey, typeof options.legacy === 'string' ? options.legacy : JSON.stringify(options.legacy));
    let writes = 0, prints = 0, filePickerClicks = 0, now = 1000;
    const document = { activeElement: null };
    const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]));
    const listen = (registry, type, handler) => registry.set(type, [...registry.get(type) || [], handler]);
    const matches = (element, selector) => {
      if (selector.includes(',')) return selector.split(',').some(part => matches(element, part.trim()));
      if (selector === ':focus-visible') return element.focusVisible === true;
      const ancestor = selector.match(/^([^\[]+?)\s+(.+)$/);
      if (ancestor) {
        if (!matches(element, ancestor[2])) return false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) if (matches(parent, ancestor[1])) return true;
        return false;
      }
      const tag = selector.match(/^[\w-]+/), id = selector.match(/#([\w-]+)/);
      if (tag && element.tagName !== tag[0].toUpperCase() || id && element.id !== id[1]) return false;
      for (const className of selector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(className[1])) return false;
      for (const attribute of selector.matchAll(/\[([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
        if (!element.hasAttribute(attribute[1])) return false;
        const value = attribute[2] ?? attribute[3] ?? attribute[4];
        if (value !== undefined && element.getAttribute(attribute[1]) !== value) return false;
      }
      return Boolean(tag || id || selector.startsWith('[') || selector.startsWith('.'));
    };
    const makeNode = (tagName, attributes = new Map()) => {
      const listeners = new Map();
      const element = {
        tagName: tagName.toUpperCase(), id: attributes.get('id') || '', dataset: {},
        children: [], value: attributes.get('value') || '', files: [], _text: '', listeners,
        scrollTop: 0, scrollLeft: 0,
        style: { transform: '', setProperty(name, value) { this[name] = String(value); } },
        checked: attributes.has('checked'), hidden: attributes.has('hidden'),
        disabled: attributes.has('disabled'), open: attributes.has('open'),
        getAttribute: name => attributes.get(name) ?? null,
        hasAttribute: name => ['open', 'hidden', 'checked', 'disabled'].includes(name) ? element[name] : attributes.has(name),
        setAttribute(name, value) {
          attributes.set(name, String(value));
          if (['open', 'hidden', 'checked', 'disabled'].includes(name)) element[name] = true;
          if (name === 'id') element.id = String(value);
          if (name.startsWith('data-')) element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
        },
        removeAttribute(name) {
          attributes.delete(name);
          if (['open', 'hidden', 'checked', 'disabled'].includes(name)) element[name] = false;
          if (name.startsWith('data-')) delete element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
        },
        matches: selector => matches(element, selector),
        closest(selector) {
          for (let candidate = element; candidate; candidate = candidate.parentElement) {
            if (matches(candidate, selector)) return candidate;
          }
          return null;
        },
        contains(candidate) {
          for (let current = candidate; current; current = current.parentElement) {
            if (current === element) return true;
          }
          return false;
        },
        focus() { document.activeElement = element; },
        blur() { if (document.activeElement === element) document.activeElement = null; },
        showModal() { element.modalTrigger = document.activeElement; element.open = true; },
        close() {
          element.open = false;
          if (element.modalTrigger?.isConnected) element.modalTrigger.focus();
          for (const handler of listeners.get('close') || []) handler({ type: 'close', target: element });
        },
        querySelectorAll: selector => descendants(element.children).filter(candidate => matches(candidate, selector)),
        querySelector: selector => element.querySelectorAll(selector)[0] || null,
        replaceWith(replacement) {
          const parent = element.parentElement;
          if (!parent || replacement === element) return;
          if (replacement.parentElement) replacement.parentElement.children = replacement.parentElement.children.filter(child => child !== replacement);
          parent.children.splice(parent.children.indexOf(element), 1, replacement);
          replacement.parentElement = parent;
          element.parentElement = null;
        },
        addEventListener: (type, handler) => listen(listeners, type, handler),
        setPointerCapture: pointerId => pointerCaptures.set(pointerId, element),
        releasePointerCapture(pointerId) { if (pointerCaptures.get(pointerId) === element) pointerCaptures.delete(pointerId); },
        hasPointerCapture: pointerId => pointerCaptures.get(pointerId) === element,
        scrollTo(first, second) {
          element.scrollTop = typeof first === 'object' ? first.top ?? element.scrollTop : second ?? element.scrollTop;
          element.scrollLeft = typeof first === 'object' ? first.left ?? element.scrollLeft : first ?? element.scrollLeft;
        },
        scrollIntoView() {},
        // Synthetic anchor geometry tests recovery math only; this is not visual proof.
        getBoundingClientRect() {
          const step = element.dataset.readerStep;
          return { top: step === undefined ? 0 : 100 + Number(step) * 500 - (document.getElementById('view')?.scrollTop || 0), left: 0, height: 500, width: 390 };
        },
        click() {
          if (element.tagName === 'A') downloads.push({ filename: element.download, blob: blobs.get(element.href) });
          else if (element.id === 'import-file') filePickerClicks += 1;
          else return dispatch('click', element);
        },
      };
      element.classList = {
        contains: name => (attributes.get('class') || '').split(/\s+/).includes(name),
        toggle(name, force) {
          const classes = new Set((attributes.get('class') || '').split(/\s+/).filter(Boolean));
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
          attributes.set('class', [...classes].join(' '));
          return enabled;
        },
      };
      for (const [name, value] of attributes) {
        if (name.startsWith('data-')) element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      }
      Object.defineProperty(element, 'isConnected', { get: () => allNodes().includes(element) });
      Object.defineProperty(element, 'textContent', {
        get: () => element._text + element.children.map(child => child.textContent).join(''),
        set(value) { element._text = String(value); element.children = []; },
      });
      let innerHTML = '';
      Object.defineProperty(element, 'innerHTML', {
        get: () => innerHTML,
        set(value) {
          if (document.activeElement && element.contains(document.activeElement)) document.activeElement = null;
          innerHTML = String(value);
          element._text = '';
          element.children = parse(innerHTML);
          for (const child of element.children) child.parentElement = element;
        },
      });
      return element;
    };
    const parse = markup => {
      const elements = [], parents = [];
      for (const match of markup.matchAll(/<(\/)?([a-z][\w-]*)\b([^>]*)>|([^<]+)/gi)) {
        if (match[4]) {
          if (parents.length) parents.at(-1)._text += decode(match[4]);
          continue;
        }
        const tagName = match[2].toUpperCase();
        if (match[1]) {
          const position = parents.findLastIndex(element => element.tagName === tagName);
          if (position !== -1) {
            if (tagName === 'TEXTAREA') parents[position].value = parents[position].textContent;
            parents.length = position;
          }
          continue;
        }
        const attributes = new Map(Array.from(match[3].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g),
          attribute => [attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')]));
        const element = makeNode(tagName, attributes);
        element.parentElement = parents.at(-1) || null;
        if (element.parentElement) element.parentElement.children.push(element); else elements.push(element);
        if (tagName === 'OPTION' && element.parentElement?.tagName === 'SELECT' && (attributes.has('selected') || element.parentElement.children.length === 1)) element.parentElement.value = element.value;
        if (!['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'].includes(tagName)) parents.push(element);
      }
      return elements;
    };
    const staticNodes = parse(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ''));
    function descendants(elements) { return elements.flatMap(element => [element, ...descendants(element.children)]); }
    function allNodes() { return descendants(staticNodes); }
    document.getElementById = id => allNodes().find(element => element.id === id) || null;
    document.querySelectorAll = selector => allNodes().filter(element => matches(element, selector));
    document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
    document.addEventListener = (type, handler) => listen(handlers, type, handler);
    document.createElement = makeNode;
    const node = id => {
      const element = document.getElementById(id);
      assert.ok(element, `缺少 DOM 节点 ${id}`);
      return element;
    };
    const dispatch = (type, target, extra = {}) => {
      const pointer = type.startsWith('pointer') ? { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: /up|cancel/.test(type) ? 0 : 1, clientX: 0, clientY: 0 } : {};
      const pointerId = extra.pointerId ?? pointer.pointerId;
      if (['pointermove', 'pointerup', 'pointercancel'].includes(type)) target = pointerCaptures.get(pointerId) || target;
      const event = { type, target, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...pointer, ...extra };
      const path = [];
      for (let current = target; current && current !== document && current !== browser; current = current.parentElement) path.push([current, current.listeners?.get(type) || []]);
      path.push([document, handlers.get(type) || []], [browser, windowHandlers.get(type) || []]);
      assert.ok(path.some(([, callbacks]) => callbacks.length) || type === 'cancel' || type.startsWith('pointer'), `缺少 ${type} 事件处理器`);
      const results = [];
      for (const [current, callbacks] of path) {
        event.currentTarget = current;
        for (const handler of callbacks) results.push(handler(event));
        if (event.stopped) break;
      }
      event.currentTarget = null;
      if (['pointerup', 'pointercancel'].includes(type)) pointerCaptures.delete(pointerId);
      if (type === 'cancel' && !event.defaultPrevented) target.close();
      return results.some(result => result?.then) ? Promise.all(results) : event;
    };
    const location = { pathname: '/', search: '', href: '' };
    let locationHash = '';
    const entries = [];
    let historyIndex = -1;
    const setLocation = value => {
      locationHash = value ? `#${String(value).replace(/^#/, '')}` : '';
      location.href = `http://prototype.test/${locationHash}`;
    };
    Object.defineProperty(location, 'hash', {
      get: () => locationHash,
      set(value) {
        const previous = locationHash;
        setLocation(value);
        if (locationHash !== previous || !entries.length) {
          entries.splice(historyIndex + 1, entries.length, { hash: locationHash, state: options.historyState || null });
          historyIndex += 1;
        }
      },
    });
    location.hash = options.hash || '';
    const emitWindow = (type, event = {}) => { event.type = type; for (const handler of windowHandlers.get(type) || []) handler(event); };
    const history = {
      get length() { return entries.length; },
      get state() { return entries[historyIndex].state; },
      pushState(value, title, url) {
        if (options.pushError) throw new Error('history push blocked');
        const hash = new URL(url, location.href).hash;
        entries.splice(historyIndex + 1, entries.length, { hash, state: plain(value) });
        historyIndex += 1;
        setLocation(hash);
      },
      replaceState(value, title, url) {
        if (options.replaceError) throw new Error('history replace blocked');
        const hash = new URL(url, location.href).hash;
        entries[historyIndex] = { hash, state: plain(value) };
        setLocation(hash);
      },
      back() {
        if (!historyIndex) return;
        historyIndex -= 1;
        setLocation(entries[historyIndex].hash);
        emitWindow('popstate', { state: history.state });
      },
      forward() {
        if (historyIndex >= entries.length - 1) return;
        historyIndex += 1;
        setLocation(entries[historyIndex].hash);
        emitWindow('popstate', { state: history.state });
      },
    };
    const browser = {
      document, Blob, Date: class extends Date { static now() { return now; } },
      history, location, scrollY: 0,
      innerHeight: options.innerHeight ?? 844, visualViewport: options.visualViewport,
      scrollTo(first, second) { browser.scrollY = typeof first === 'object' ? first.top || 0 : second || 0; },
      addEventListener: (type, handler) => listen(windowHandlers, type, handler),
      requestAnimationFrame: action => { action(); return 1; },
      URL: class extends URL {
        static createObjectURL(blob) { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }
        static revokeObjectURL() {}
      },
      setTimeout: action => { action(); return 1; },
      clearTimeout() {},
      localStorage: {
        getItem(key) { if (options.readError) throw new Error('storage read blocked'); return storage.get(key) ?? null; },
        setItem(key, value) { writes += 1; if (options.writeError) throw new Error('storage write blocked'); storage.set(key, value); },
      },
      sessionStorage: {
        getItem(key) { if (options.sessionReadError) throw new Error('session read blocked'); return session.get(key) ?? null; },
        setItem(key, value) { if (options.sessionWriteError) throw new Error('session write blocked'); session.set(key, value); },
        removeItem(key) { if (options.sessionWriteError) throw new Error('session write blocked'); session.delete(key); },
      },
      confirm(message) { confirmations.push(message); throw new Error('确认操作必须使用 confirmation-sheet'); },
      print() { prints += 1; },
    };
    browser.window = browser;
    const page = vm.createContext(browser);
    const appScripts = [...markup.matchAll(/<script\b(?=[^>]*\bid\s*=\s*["']app-logic["'])[^>]*>([\s\S]*?)<\/script\s*>/gi)];
    assert.equal(appScripts.length, 1, '必须恰有一个 script#app-logic');
    for (const script of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const source = script[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (source) {
        assert.equal(source[1], './weekend-household-model.js', '只加载显式允许的本地模型脚本');
        const scriptPath = join(__dirname, 'weekend-household-model.js');
        vm.runInContext(readFileSync(scriptPath, 'utf8'), page, { filename: scriptPath, timeout: 1000 });
      } else vm.runInContext(script[2], page, { filename, timeout: 1000 });
    }
    const storedData = () => {
      if (storage.has(householdKey)) {
        const value = JSON.parse(storage.get(householdKey));
        return value.meals.find(meal => meal.id === value.activeMealId)?.data;
      }
      return storage.has(legacyKey) ? JSON.parse(storage.get(legacyKey)) : undefined;
    };
    const button = (action, data = {}) => {
      const selector = `[data-action="${action}"]${Object.entries(data).map(([key, value]) => `[data-${key}="${value}"]`).join('')}`;
      const target = document.querySelector(selector);
      assert.ok(target, `缺少按钮 ${selector}`);
      return target;
    };
    const api = {
      document, node, downloads, confirmations, history, location, dispatch, button,
      read: () => plain(vm.runInContext('state', page)),
      evaluate: expression => vm.runInContext(expression, page, { timeout: 1000 }),
      view: () => node('view').innerHTML,
      sheet: () => node('sheet-view').innerHTML,
      saved: storedData,
      raw: () => storage.has(householdKey) ? JSON.stringify(storedData()) : storage.get(legacyKey),
      household: () => plain(vm.runInContext('household', page)),
      storedHousehold: () => storage.has(householdKey) ? JSON.parse(storage.get(householdKey)) : undefined,
      householdRaw: () => storage.get(householdKey),
      session: () => Object.fromEntries(session),
      legacyRaw: () => storage.get(legacyKey),
      writes: () => writes,
      prints: () => prints,
      filePickerClicks: () => filePickerClicks,
      advance(milliseconds = 250) { now += milliseconds; },
      emitWindow,
      tab(tab) {
        const tabbar = node('tabbar'), target = tabbar.querySelector(`button[data-tab="${tab}"]`);
        assert.equal(tabbar.hidden, false, '通过实际显示的 Tab 导航');
        assert.ok(target);
        assert.equal(target.hidden, false);
        assert.equal(target.disabled, false);
        return api.click(target);
      },
      confirm(accept = true) {
        assert.equal(node('confirmation-sheet').open, true, '必须先显示确认弹层');
        const result = api.click(button(accept ? 'confirm-action' : 'cancel-confirmation'));
        assert.equal(node('confirmation-sheet').open, false);
        return result;
      },
      go(route) {
        api.closeSheet();
        if (location.hash.replace(/^#\/?/, '') !== route) vm.runInContext(`navigate(${JSON.stringify(route)})`, page, { timeout: 1000 });
        if (['home', 'library'].includes(route)) {
          for (let remaining = 200; location.hash !== `#${route}` && remaining > 0; remaining -= 1) api.click(button('back'));
          assert.equal(location.hash, `#${route}`, '测试导航必须在有限步内到达根页');
        }
      },
      closeSheet() { if (node('editor-sheet').open) api.click(button('close-sheet')); },
      open(action, data = {}) {
        api.closeSheet();
        const route = { 'open-item': 'recipe-edit', 'open-stock': 'shopping', 'open-save': 'meal', 'open-add': 'recipe-edit', 'open-pending': 'shopping', 'new-meal': 'plan', 'new-menu': 'library', 'new-recipe': 'library', 'new-guest': 'profile', 'edit-guest': 'profile', 'meal-actions': 'plan', 'edit-meal': 'meal' }[action];
        if (route) api.go(route);
        if (action === 'new-menu') api.click(button('library-section', { value: 'menus' }));
        const trigger = button(action, data);
        trigger.focus();
        api.click(trigger);
        if (['new-meal', 'new-menu', 'edit-meal'].includes(action)) {
          assert.equal(location.hash, '#select');
          assert.equal(node('editor-sheet').open, false, '选菜使用全屏页面');
          return trigger;
        }
        assert.equal(node('editor-sheet').open, true, `${action} 应打开 sheet`);
        assert.equal(document.activeElement, node('sheet-title'), 'sheet 打开后聚焦标题');
        return trigger;
      },
      click(target) {
        if (!target.tagName) target = makeNode('button', new Map(Object.entries(target).map(([key, value]) => [`data-${key}`, String(value)])));
        const control = target.closest('button');
        if (control && !control.disabled) control.focus();
        return dispatch('click', target);
      },
      reader(paragraph, offset = 0) {
        const sections = node('view').querySelectorAll('[data-reader-step]');
        assert.ok(Number.isInteger(paragraph) && paragraph >= 1 && paragraph <= sections.length, '阅读段落必须真实存在');
        node('view').scrollTop = 100 + (paragraph - 1) * 500 + offset;
        dispatch('scroll', node('view'));
        emitWindow('pagehide');
      },
      purchase(id, checked) {
        api.go('shopping');
        const checkbox = document.querySelector(`[data-purchase="${id}"]`);
        assert.ok(checkbox, `采购清单缺少 ${id} checkbox`);
        assert.equal(checkbox.disabled, false, '已备齐或未填用量也必须可操作');
        checkbox.checked = checked;
        return dispatch('change', checkbox);
      },
      input(id, value) {
        if (id.startsWith('quantity-') && (!node('editor-sheet').open || !document.getElementById(id))) api.open('open-item', { item: id.slice(9) });
        if (id === 'notes') api.go('recipe-edit');
        const target = id === 'notes' ? document.querySelector('[data-notes]') : node(id);
        assert.ok(target, `缺少输入框 ${id}`);
        target.value = value;
        return dispatch('input', target);
      },
      finishAdjustment() {
        api.go('recipe-edit');
        return api.click(button('finish-adjustment'));
      },
      choose(id, value) {
        const control = () => node('sheet-view').querySelector(`button[data-action="choice"][data-item="${id}"][data-value="${value}"]`);
        if (!node('editor-sheet').open || !control()) api.open('open-item', { item: id });
        return api.click(button('choice', { item: id, value }));
      },
      stock(id, checked) {
        const target = document.querySelector(`[data-stock="${id}"]`);
        assert.ok(target, `库存 sheet 缺少 ${id}`);
        target.checked = checked;
        return dispatch('change', target);
      },
      selectBuilder(kind, ids) {
        const controls = node('view').querySelectorAll(`[data-builder-${kind}]`);
        for (const id of ids) assert.ok(controls.some(control => control.getAttribute(`data-builder-${kind}`) === id), `选择器缺少 ${kind} ${id}`);
        for (const control of controls) {
          control.checked = ids.includes(control.getAttribute(`data-builder-${kind}`));
          dispatch('change', control);
        }
      },
      import(value) {
        api.go('backup');
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        const target = node('import-file');
        target.value = 'weekend-menu-backup.json';
        target.files = [{ size: Buffer.byteLength(content), text: async () => content }];
        return dispatch('change', target);
      },
    };
    return api;
  }

  const stubMarkup = '<header id="navigation-bar"></header><main id="view"></main><dialog id="editor-sheet"><div id="sheet-view"></div></dialog><script id="app-logic"></script>';

  const activeMeal = page => page.household().meals.find(meal => meal.id === page.household().activeMealId);
  const createMeal = (page, title, recipeIds, guestIds = []) => {
    const trigger = page.document.querySelector('[data-action="new-meal"]');
    if (trigger) page.click(trigger); else page.open('new-meal');
    page.input('builder-title', title);
    page.selectBuilder('recipe', recipeIds);
    assert.deepEqual(guestIds, [], 'C 不新增用餐人选择，旧数据另外验证保留');
    page.click(page.button('save-builder'));
    assert.equal(page.node('editor-sheet').open, false, page.document.getElementById('sheet-message')?.textContent);
    assert.equal(activeMeal(page).title, title);
    return activeMeal(page).id;
  };

  check('家庭 UI：首次打开仅内存迁移，实际修改才写 v2 且原 v1 字节不变', () => {
    for (const initial of [fresh(), complete()]) {
      const page = loadPage(initial), legacy = JSON.stringify(initial);
      assert.equal(page.writes(), 0);
      assert.equal(page.legacyRaw(), legacy);
      assert.equal(page.raw(), legacy);
      assert.deepEqual(page.saved(), plain(initial));
      assert.equal(page.storedHousehold(), undefined);
      assert.equal(page.household().schemaVersion, 2);
      assert.deepEqual(activeMeal(page).data, plain(initial || fresh()));
      page.purchase('bacon', true);
      assert.equal(page.writes(), 1);
      assert.equal(page.storedHousehold().schemaVersion, 2);
      assert.deepEqual(page.storedHousehold(), page.household());
      assert.equal(page.legacyRaw(), legacy);
    }
  });

  check('家庭 UI：合法旧 dish 超过60字仍迁移保留全部原材料', () => {
    const initial = plain(complete());
    item(initial, 'beef').dish = '旧菜名'.repeat(30);
    assert.equal(model.validate(initial), true);
    const page = loadPage(initial);
    assert.deepEqual(page.read(), initial, '迁移不能回退默认配方');
    assert.equal(page.evaluate('HouseholdModel.validate(household)'), true);
    assert.equal(page.legacyRaw(), JSON.stringify(initial));
    assert.equal(page.storedHousehold(), undefined);
    assert.equal(page.writes(), 0);
    page.open('new-meal');
    const recipe = page.household().recipes.find(entry => entry.name === item(initial, 'beef').dish);
    page.selectBuilder('recipe', [recipe.id]);
    page.click(page.button('save-builder'));
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(activeMeal(page).recipeIds[0], recipe.id);
    assert.ok(activeMeal(page).title.length <= 60);
    assert.equal(page.read().items[0].dish, recipe.name);
  });

  check('家庭 UI：选菜页未选时禁用，选菜自动命名，无名常做菜单仍拒绝', () => {
    const page = loadPage(), before = page.household();
    page.open('new-meal');
    assert.equal(page.node('screen-next').disabled, true);
    page.click(page.button('save-builder'));
    assert.equal(page.location.hash, '#select');
    assert.deepEqual(page.household(), before);
    assert.equal(page.writes(), 0);
    page.selectBuilder('recipe', ['rice']);
    assert.equal(page.node('screen-next').disabled, false);
    page.click(page.button('save-builder'));
    assert.equal(page.location.hash, '#shopping');
    assert.equal(activeMeal(page).title, '米饭');
    page.open('new-menu');
    page.selectBuilder('recipe', ['rice']);
    const stored = page.householdRaw(), writes = page.writes();
    page.click(page.button('save-builder'));
    assert.equal(page.location.hash, '#select');
    assert.match(page.node('message').textContent, /名称/);
    assert.equal(page.householdRaw(), stored);
    assert.equal(page.writes(), writes);
  });

  check('家庭 UI：真正首次使用为空，首页选菜和菜谱链接入口可达且不写入', () => {
    const page = loadPage(undefined, { firstUse: true });
    assert.deepEqual(page.household(), { schemaVersion: 2, activeMealId: null, meals: [], recipes: [], menus: [], guests: [] });
    assert.equal(page.legacyRaw(), undefined);
    assert.equal(page.householdRaw(), undefined);
    assert.equal(page.node('screen-next').dataset.action, 'new-meal');
    page.click(page.node('screen-next'));
    assert.equal(page.location.hash, '#select');
    assert.equal(page.node('screen-next').disabled, true);
    assert.ok(page.button('builder-new-recipe'));
    page.go('library');
    assert.ok(page.button('new-recipe'));
    page.click(page.button('library-section', { value: 'menus' }));
    assert.ok(page.button('new-menu'));
    assert.equal(page.document.querySelector('[data-action="new-guest"]'), null);
    assert.equal(page.writes(), 0);
  });

  check('家庭 UI：新增餐自主选菜，采购、口味和库存互不串餐', () => {
    const page = loadPage(complete()), first = activeMeal(page);
    const secondId = createMeal(page, '周六独立晚饭', ['beef', 'rice']);
    assert.notEqual(secondId, first.id);
    assert.deepEqual(page.household().meals.find(meal => meal.id === first.id), first);
    assert.deepEqual(activeMeal(page).recipeIds, ['beef', 'rice']);
    assert.ok(page.read().items.every(entry => entry.status === 'unchecked'));
    page.purchase('bacon', true);
    page.input('quantity-beef', '900克');
    page.input('notes', '只属于周六这餐');
    page.purchase('rice', true);
    const second = activeMeal(page);
    page.go('plan');
    page.click(page.button('open-meal', { meal: first.id }));
    assert.deepEqual(page.read(), first.data);
    page.go('plan');
    page.click(page.button('open-meal', { meal: secondId }));
    assert.deepEqual(page.read(), second.data);
    assert.equal(item(page.saved(), 'bacon').status, 'bought');
    assert.equal(item(page.saved(), 'rice').status, 'bought');
    assert.equal(page.read().notes, '只属于周六这餐');
    assert.equal(page.legacyRaw(), JSON.stringify(complete()));
  });

  for (const [action, status] of [['cancel-meal', 'cancelled'], ['complete-meal', 'completed']]) {
    check(`家庭 UI：${action} 必须确认，历史可见且恢复同一餐`, () => {
      const page = loadPage(complete()), before = activeMeal(page);
      page.go('plan');
      page.click(page.button('meal-actions', { meal: before.id }));
      const stored = page.storedHousehold(), writes = page.writes();
      page.click(page.button(action, { meal: before.id }));
      assert.equal(page.node('confirmation-sheet').open, true);
      assert.equal(page.household().meals[0].status, 'planned');
      page.confirm(false);
      assert.deepEqual(page.household().meals[0], before);
      assert.deepEqual(page.storedHousehold(), stored);
      assert.equal(page.writes(), writes);
      page.click(page.button(action, { meal: before.id }));
      page.confirm();
      assert.equal(page.household().meals[0].status, status);
      assert.equal(page.household().activeMealId, null);
      page.go('home');
      assert.equal(page.node('view').querySelector(`[data-action="open-meal"][data-meal="${before.id}"]`), null);
      assert.equal(page.node('screen-next').dataset.action, 'new-meal');
      page.go('plan');
      assert.ok(page.button('meal-actions', { meal: before.id }));
      page.click(page.button('open-meal', { meal: before.id }));
      page.open('meal-actions', { meal: before.id });
      page.click(page.button('restore-meal', { meal: before.id }));
      assert.equal(activeMeal(page).id, before.id);
      assert.equal(activeMeal(page).status, 'planned');
      assert.deepEqual(page.read(), before.data);
      assert.deepEqual(page.storedHousehold(), page.household());
    });
  }

  check('家庭 UI：计划和首页有选错餐的管理入口，空状态可重新安排', () => {
    const page = loadPage(), id = activeMeal(page).id;
    for (const route of ['home', 'plan']) {
      page.go(route);
      page.click(page.button('meal-actions', { meal: id }));
      assert.ok(page.button('edit-meal', { meal: id }));
      assert.ok(page.button('cancel-meal', { meal: id }));
      assert.ok(page.button('complete-meal', { meal: id }));
      page.closeSheet();
    }
    page.go('plan');
    page.click(page.button('meal-actions', { meal: id }));
    page.click(page.button('cancel-meal', { meal: id }));
    page.confirm();
    for (const route of ['home', 'plan', 'meal']) {
      page.go(route);
      assert.ok(page.button('new-meal'));
    }
    createMeal(page, '重新安排', ['rice']);
    assert.equal(page.household().meals.length, 2);
  });

  check('家庭 UI：搜索按菜名食材，链接新增后完整编辑并在连续正文展示全部步骤', () => {
    const page = loadPage(), initial = activeMeal(page);
    page.go('library');
    const search = page.node('library-search');
    for (const query of ['牛肉', '培根']) {
      page.input('library-search', query);
      assert.equal(page.node('library-search'), search);
      assert.ok(page.node('library-results').querySelector('[data-route="recipe-beef"]'));
      assert.equal(page.node('library-results').querySelector('[data-route="recipe-rice"]'), null);
    }
    page.input('library-search', '不存在');
    page.click(page.button('new-recipe'));
    page.input('link-name', '番茄炒蛋');
    page.input('link-url', 'https://example.com/egg');
    page.click(page.button('save-link'));
    const recipe = page.household().recipes.find(entry => entry.name === '番茄炒蛋');
    assert.ok(recipe);
    page.go(`recipe-${recipe.id}`);
    page.click(page.button('edit-recipe', { recipe: recipe.id }));
    page.input('recipe-ingredients', '番茄｜2个\n鸡蛋｜3个');
    page.input('recipe-steps', '打散鸡蛋\n炒熟后加入番茄');
    page.click(page.button('save-recipe'));
    assert.equal(page.household().recipes.find(entry => entry.id === recipe.id).sourceUrl, recipe.sourceUrl);
    assert.deepEqual(activeMeal(page), initial);
    page.click(page.button('recipe-section', { recipe: recipe.id, value: 'method' }));
    page.click(page.button('open-cook', { recipe: recipe.id }));
    assert.deepEqual(page.node('view').querySelectorAll('.cook-description').map(node => node.textContent), ['打散鸡蛋', '炒熟后加入番茄']);
    assert.equal(page.document.querySelector('[data-action="cook-next"]'), null);
    page.reader(2);
    assert.equal(activeMeal(page).status, 'planned');
    page.go('library');
    page.input('library-search', '鸡蛋');
    assert.ok(page.node('library-results').querySelector(`[data-route="recipe-${recipe.id}"]`));
  });

  for (const save of [false, true]) {
    check(`家庭 UI：builder 新增菜谱${save ? '保存' : '取消'}后返回并保留选菜草稿`, () => {
      const page = loadPage(), before = page.household();
      page.open('new-meal');
      page.input('builder-title', '朋友聚餐草稿');
      page.input('builder-date', '2026-10-18');
      page.selectBuilder('recipe', ['rice']);
      page.click(page.button('builder-new-recipe'));
      if (save) {
        page.input('link-name', '紫菜汤');
        page.input('link-url', 'https://example.com/soup');
        page.click(page.button('save-link'));
      } else page.click(page.button('close-sheet'));
      assert.equal(page.node('editor-sheet').open, false);
      assert.equal(page.location.hash, '#select');
      assert.equal(page.node('builder-title').value, '朋友聚餐草稿');
      assert.equal(page.node('builder-date').value, '2026-10-18');
      const selected = page.node('view').querySelectorAll('[data-builder-recipe]').filter(control => control.checked).map(control => control.dataset.builderRecipe);
      assert.ok(selected.includes('rice'));
      assert.equal(selected.length, save ? 2 : 1);
      assert.deepEqual(page.household().meals, before.meals);
      if (!save) {
        assert.equal(page.writes(), 0);
        assert.equal(page.storedHousehold(), undefined);
      }
      page.click(page.button('save-builder'));
      assert.equal(activeMeal(page).title, '朋友聚餐草稿');
      assert.equal(activeMeal(page).date, '2026-10-18');
      assert.deepEqual(activeMeal(page).recipeIds, selected);
    });
  }

  check('家庭 UI：独立创建编辑餐单，复做连续新建餐且不覆盖原餐', () => {
    const page = loadPage(complete()), before = activeMeal(page);
    page.open('new-menu');
    page.input('builder-title', '随意搭配');
    page.selectBuilder('recipe', ['rice']);
    page.click(page.button('save-builder'));
    assert.equal(page.node('editor-sheet').open, false);
    const menu = page.household().menus.find(entry => entry.title === '随意搭配');
    assert.ok(menu);
    assert.deepEqual(menu.recipeIds, ['rice']);
    assert.deepEqual(activeMeal(page), before);
    page.click(page.button('edit-menu', { menu: menu.id }));
    page.input('builder-title', '素食搭配');
    page.selectBuilder('recipe', ['broccoli', 'rice']);
    page.click(page.button('save-builder'));
    const updated = page.household().menus.find(entry => entry.id === menu.id);
    assert.deepEqual([...updated.recipeIds].sort(), ['broccoli', 'rice']);
    page.open('new-meal');
    page.click(page.button('builder-section', { value: 'menus' }));
    page.selectBuilder('menu', [menu.id]);
    page.click(page.button('save-builder'));
    const firstRepeat = activeMeal(page);
    assert.notEqual(firstRepeat.id, before.id);
    page.purchase('rice', true);
    const bought = activeMeal(page);
    page.go('library');
    page.click(page.button('library-section', { value: 'menus' }));
    page.open('new-meal');
    page.click(page.button('builder-section', { value: 'menus' }));
    page.selectBuilder('menu', [menu.id]);
    page.click(page.button('save-builder'));
    assert.equal(page.household().meals.length, 3);
    assert.notEqual(activeMeal(page).id, firstRepeat.id);
    assert.ok(page.read().items.every(entry => entry.status === 'unchecked'));
    assert.deepEqual(page.household().meals.find(entry => entry.id === bought.id), bought);
    assert.deepEqual(page.household().meals.find(entry => entry.id === before.id), before);
    assert.deepEqual(page.household().menus.find(entry => entry.id === menu.id), updated);
  });

  check('家庭 UI：旧用餐人与餐内关联保留，精简选菜不覆盖隐藏数据', () => {
    const initial = loadPage().household();
    initial.guests = [{ id: 'guest-1', name: '小林', avoid: '花生过敏', note: '偏清淡' }];
    initial.meals[0].guestIds = ['guest-1'];
    const page = loadPage(initial, { household: true }), id = initial.meals[0].id;
    page.open('meal-actions', { meal: id });
    page.click(page.button('edit-meal', { meal: id }));
    assert.equal(page.document.querySelector('[data-builder-guest]'), null);
    page.input('builder-title', '只改餐名');
    page.click(page.button('save-builder'));
    assert.deepEqual(page.household().guests, initial.guests);
    assert.deepEqual(activeMeal(page).guestIds, ['guest-1']);
    assert.deepEqual(activeMeal(page).data, initial.meals[0].data);
  });

  check('家庭 UI：编辑非当前餐返回来源，重开只重置该餐受影响材料', () => {
    const page = loadPage(complete()), first = activeMeal(page);
    createMeal(page, '另一餐', ['rice']);
    page.purchase('rice', true);
    const other = activeMeal(page);
    page.go('plan');
    page.click(page.button('meal-actions', { meal: first.id }));
    page.click(page.button('edit-meal', { meal: first.id }));
    page.input('builder-title', '改成简单饭');
    page.selectBuilder('recipe', ['rice']);
    page.click(page.button('save-builder'));
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.location.hash, '#plan');
    page.click(page.button('open-meal', { meal: first.id }));
    assert.equal(activeMeal(page).id, first.id);
    assert.deepEqual(activeMeal(page).recipeIds, ['rice']);
    assert.deepEqual(page.read().items.map(entry => entry.name), ['米']);
    assert.equal(item(page.read(), 'rice').status, 'unchecked');
    assert.equal(page.read().reviewed, false);
    assert.deepEqual(page.household().meals.find(entry => entry.id === other.id), other);
    assert.deepEqual(page.storedHousehold(), page.household());
  });

  check('家庭 UI：两 Tab 往返保留 A 购物上下文，切换 B 后各餐采购独立', () => {
    const page = loadPage(), firstId = activeMeal(page).id;
    page.click(page.node('screen-next'));
    page.purchase('bacon', true);
    page.node('view').scrollTop = 182;
    page.tab('library');
    page.tab('home');
    assert.equal(page.location.hash, '#shopping');
    assert.equal(page.history.state.stack.at(-1).mealId, firstId);
    assert.equal(page.node('view').scrollTop, 182);
    const first = activeMeal(page);
    const secondId = createMeal(page, '餐 B', ['beef']);
    page.purchase('celery', true);
    const second = activeMeal(page);
    page.go('plan');
    page.click(page.button('open-meal', { meal: firstId }));
    assert.deepEqual(page.read(), first.data);
    page.purchase('celery', true);
    assert.deepEqual(page.household().meals.find(meal => meal.id === secondId), second);
    page.go('plan');
    page.click(page.button('open-meal', { meal: secondId }));
    assert.deepEqual(page.read(), second.data);
    assert.equal(item(page.read(), 'bacon').status, 'unchecked');
  });

  check('家庭 UI：同 #shopping 的浏览器后退前进恢复各自 mealId 和采购', () => {
    const page = loadPage(), firstId = activeMeal(page).id;
    page.go('plan');
    const secondId = createMeal(page, '餐 B', ['rice']);
    page.purchase('rice', true);
    const second = activeMeal(page);
    page.go('plan');
    page.click(page.button('open-meal', { meal: firstId }));
    assert.equal(page.location.hash, '#shopping');
    const firstState = plain(page.history.state), first = page.read();
    page.go('plan');
    page.click(page.button('open-meal', { meal: secondId }));
    const secondState = plain(page.history.state), writes = page.writes();
    assert.equal(page.location.hash, '#shopping');
    page.history.pushState(firstState, '', '#shopping');
    page.history.pushState(secondState, '', '#shopping');
    page.history.back();
    assert.equal(page.evaluate('currentMeal().id'), firstId);
    assert.deepEqual(page.read(), first);
    page.history.forward();
    assert.equal(page.evaluate('currentMeal().id'), secondId);
    assert.deepEqual(page.read(), second.data);
    assert.equal(page.writes(), writes);
  });

  check('家庭 UI：买齐未核对也可做饭，看完步骤仍是待做餐，仅人工确认完成', () => {
    const page = loadPage();
    for (const entry of page.read().items) {
      if (entry.choice !== 'include') page.choose(entry.id, 'include');
      page.input(`quantity-${entry.id}`, '1份');
      page.purchase(entry.id, true);
      assert.equal(activeMeal(page).status, 'planned');
    }
    page.finishAdjustment();
    assert.equal(page.read().reviewed, false);
    assert.equal(summary(page.read()).ready, false, 'legacy ready 保持原模型语义，不阻止查看做法');
    assert.equal(summary(page.read()).unchecked + summary(page.read()).missingQuantities + summary(page.read()).unresolvedChoices, 0);
    assert.equal(activeMeal(page).status, 'planned');
    page.go('recipe-beef');
    page.click(page.button('recipe-section', { recipe: 'beef', value: 'method' }));
    page.click(page.button('open-cook', { recipe: 'beef' }));
    const writes = page.writes(), stored = page.householdRaw();
    page.reader(page.household().recipes.find(recipe => recipe.id === 'beef').steps.length);
    assert.equal(activeMeal(page).status, 'planned');
    assert.equal(page.writes(), writes);
    assert.equal(page.householdRaw(), stored);
    page.go('cook');
    page.click(page.button('complete-meal', { meal: activeMeal(page).id }));
    assert.equal(activeMeal(page).status, 'planned');
    page.confirm();
    assert.equal(page.household().meals[0].status, 'completed');
  });

  check('DOM 桩支持多个动态根、局部查询和 closest，不保留被替换的节点', () => {
    const page = loadPage(undefined, { html: stubMarkup });
    page.node('navigation-bar').innerHTML = '<h1 id="screen-title">餐单</h1><button data-action="back"><span id="back-icon"></span></button>';
    page.node('view').innerHTML = '<section><button id="meal-button" data-route="meal">查看</button></section>';
    page.node('sheet-view').innerHTML = '<div class="sheet-body"><button data-action="choice" data-item="bacon" data-value="include" aria-pressed="true"><span id="choice-label">保留</span></button></div>';
    assert.equal(page.node('navigation-bar').contains(page.node('screen-title')), true);
    assert.equal(page.node('view').contains(page.node('screen-title')), false);
    assert.deepEqual(page.document.querySelectorAll('button').map(element => element.dataset.action || element.dataset.route), ['back', 'meal', 'choice']);
    for (const button of page.node('sheet-view').querySelectorAll('[data-action="choice"]')) {
      assert.equal(button.closest('#editor-sheet'), page.node('editor-sheet'));
      assert.equal(button.getAttribute('aria-pressed'), 'true');
    }
    assert.equal(page.node('choice-label').closest('button[data-action="choice"]'), page.node('sheet-view').querySelector('button'));
    assert.equal(page.node('back-icon').closest('button, a').dataset.action, 'back');
    const previous = page.node('screen-title'), sheetButton = page.node('sheet-view').querySelector('button');
    page.node('navigation-bar').innerHTML = '<h1 id="screen-title">采购</h1>';
    assert.equal(previous.isConnected, false);
    assert.notEqual(page.node('screen-title'), previous);
    assert.equal(page.node('sheet-view').querySelector('button'), sheetButton);
    const detached = page.document.createElement('div');
    detached.innerHTML = '<button data-action="choice"><span></span></button>';
    assert.equal(detached.querySelectorAll('button').length, 1);
    assert.equal(detached.querySelector('span').closest('button'), detached.querySelector('button'));
    assert.equal(detached.querySelector('button').isConnected, false);
  });

  check('DOM 桩的 view、sheet 和 sheet-body 独立记录 scrollTop', () => {
    const page = loadPage(undefined, { html: stubMarkup });
    page.node('sheet-view').innerHTML = '<div class="sheet-body"></div>';
    const view = page.node('view'), sheet = page.node('sheet-view'), body = sheet.querySelector('.sheet-body');
    assert.deepEqual([view.scrollTop, sheet.scrollTop, body.scrollTop], [0, 0, 0]);
    view.scrollTop = 320;
    sheet.scrollTo({ top: 90 });
    body.scrollTo(0, 45);
    assert.deepEqual([view.scrollTop, sheet.scrollTop, body.scrollTop], [320, 90, 45]);
    assert.equal(page.evaluate('window.scrollY'), 0);
    page.evaluate('window.scrollTo({ top: 12 })');
    assert.deepEqual([view.scrollTop, sheet.scrollTop, body.scrollTop], [320, 90, 45]);
    assert.equal(page.evaluate('window.scrollY'), 12);
  });

  check('取舍助手真实点击指定材料的选择按钮', () => {
    const page = loadPage(undefined, { html: stubMarkup }), events = [];
    page.node('editor-sheet').showModal();
    page.node('sheet-view').innerHTML = ['include', 'omit', 'pending'].map(value => `<button data-action="choice" data-item="bacon" data-value="${value}">${value}</button>`).join('');
    page.document.addEventListener('click', event => events.push([event.type, event.target.dataset.item, event.target.dataset.value]));
    page.choose('bacon', 'omit');
    assert.deepEqual(events, [['click', 'bacon', 'omit']]);
    page.choose('bacon', 'pending');
    assert.deepEqual(events, [['click', 'bacon', 'omit'], ['click', 'bacon', 'pending']]);
  });

  check('DOM 桩的 pointer 事件冒泡、捕获和取消保留坐标与 currentTarget', () => {
    const page = loadPage(undefined, { html: stubMarkup });
    page.node('view').innerHTML = '<button><span id="pointer-target"></span></button>';
    const view = page.node('view'), target = page.node('pointer-target'), seen = [];
    view.addEventListener('pointerdown', event => {
      seen.push([event.type, event.target, event.currentTarget, event.pointerId, event.clientX, event.clientY, event.pointerType, event.isPrimary]);
      event.currentTarget.setPointerCapture(event.pointerId);
    });
    page.document.addEventListener('pointerdown', event => seen.push([event.type, event.currentTarget]));
    page.dispatch('pointerdown', target, { pointerId: 7, clientX: 8, clientY: 210 });
    assert.deepEqual(seen, [['pointerdown', target, view, 7, 8, 210, 'touch', true], ['pointerdown', page.document]]);
    assert.equal(view.hasPointerCapture(7), true);
    view.addEventListener('pointermove', event => {
      assert.equal(event.target, view);
      assert.equal(event.currentTarget, view);
      event.preventDefault();
    });
    const move = page.dispatch('pointermove', page.node('navigation-bar'), { pointerId: 7, clientX: 150, clientY: 214 });
    assert.equal(move.defaultPrevented, true);
    assert.equal(move.currentTarget, null);
    page.dispatch('pointercancel', target, { pointerId: 7 });
    assert.equal(view.hasPointerCapture(7), false);
    view.setPointerCapture(8);
    page.dispatch('pointerup', target, { pointerId: 8 });
    assert.equal(view.hasPointerCapture(8), false);
    view.setPointerCapture(9);
    view.releasePointerCapture(9);
    assert.equal(view.hasPointerCapture(9), false);
    const bubbling = [];
    target.addEventListener('pointerup', event => { bubbling.push('target'); event.stopPropagation(); });
    target.addEventListener('pointerup', () => bubbling.push('same-target'));
    view.addEventListener('pointerup', () => bubbling.push('view'));
    page.dispatch('pointerup', target);
    assert.deepEqual(bubbling, ['target', 'same-target']);
  });

  const assertPersisted = page => {
    assert.deepEqual(page.saved(), page.read());
    assert.deepEqual(page.storedHousehold(), page.household());
    assert.equal(page.evaluate('HouseholdModel.validate(household)'), true);
  };
  const checkAsync = async (name, action) => {
    try {
      await action();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message.slice(0, 1200)}\n${error.stack?.split('\n').find(line => line.includes('check.cjs:')) || ''}`);
    }
  };

  check('默认 home，两个根导航和单页容器保留且不写入配方', () => {
    const page = loadPage();
    assert.equal(page.evaluate('Object.hasOwn(globalThis, "state")'), false, 'state 保持顶层 let');
    assert.equal(page.evaluate('typeof navigate'), 'function');
    assert.deepEqual(page.read(), plain(fresh()));
    assert.equal(page.location.hash, '#home');
    assert.equal(page.node('view').tagName, 'MAIN');
    assert.equal(page.node('screen-title').tagName, 'H1');
    assert.ok(page.node('screen-title').textContent.trim());
    assert.equal(page.node('tabbar').tagName, 'NAV');
    assert.ok(page.node('navigation-bar').contains(page.node('screen-title')));
    assert.equal(page.node('view').contains(page.node('screen-title')), false);
    assert.deepEqual(page.node('tabbar').querySelectorAll('button[data-tab]').map(button => button.dataset.tab), ['home', 'library']);
    assert.equal(page.node('tabbar').hidden, false);
    assert.equal(page.document.querySelectorAll('[data-purchase]').length, 0);
    assert.equal(page.document.querySelectorAll('[data-field="quantity"]').length, 0);
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.node('confirmation-sheet').open, false);
    assert.doesNotMatch(html, /window\.confirm\s*\(/);
    assert.equal(page.document.getElementById('undo-purchase'), null);
    assert.deepEqual(page.saved(), plain(fresh()));
    assert.equal(page.raw(), JSON.stringify(fresh()));
    assert.equal(page.storedHousehold(), undefined);
    assert.equal(page.writes(), 0);
  });

  check('C 首页：当前餐长标题与真实进度，主按钮直接买菜，返回保留滚动', () => {
    const household = loadPage().household(), meal = household.meals[0];
    meal.title = '周六请朋友来家里吃勃艮第炖牛肉配西兰花和米饭'.repeat(2);
    meal.data.items.find(item => item.id === 'bacon').status = 'bought';
    household.activeMealId = null;
    const page = loadPage(household, { household: true });
    assert.equal(page.document.querySelector('.c-meal-title').textContent, meal.title);
    assert.match(page.document.querySelector('.c-resume').textContent, /1 \/ 14 样备齐/);
    assert.equal(page.node('view').querySelector('.primary'), null);
    assert.equal(page.node('screen-next').dataset.meal, meal.id);
    page.node('view').scrollTop = 172;
    page.click(page.node('screen-next'));
    assert.equal(page.location.hash, '#shopping');
    assert.deepEqual(plain(page.history.state.stack).map(entry => entry.route), ['home', 'shopping']);
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#home');
    assert.equal(page.node('view').scrollTop, 172);
    assert.deepEqual(page.household().meals[0], meal);
  });

  check('C 首页：买齐也先继续买菜，未阅读不伪造阅读进度；无待做餐可安排新餐', () => {
    const page = loadPage(complete());
    assert.equal(page.node('screen-next').dataset.action, 'open-meal');
    assert.equal(page.node('screen-next').textContent, '继续买菜');
    page.click(page.node('screen-next'));
    assert.equal(page.location.hash, '#shopping');
    page.click(page.node('screen-next'));
    assert.equal(page.location.hash, '#cook');
    assert.equal(activeMeal(page).status, 'planned');
    page.go('home');
    assert.equal(page.node('screen-next').textContent, '继续做饭');
    assert.equal(page.node('view').querySelector('[data-action="use-menu"]'), null);
    const household = page.household();
    household.meals[0].status = 'completed'; household.activeMealId = null;
    const history = loadPage(household, { household: true });
    assert.equal(history.node('screen-next').dataset.action, 'new-meal');
    history.click(history.node('screen-next'));
    assert.equal(history.location.hash, '#select');
    assert.deepEqual(history.household(), household);
  });

  check('C 历史：取消餐可恢复，完成餐通过选菜复做，原餐和采购不被覆盖', () => {
    for (const status of ['completed', 'cancelled']) {
      const household = loadPage(complete()).household(), meal = household.meals[0];
      meal.status = status; household.activeMealId = null;
      const page = loadPage(household, { household: true });
      page.go('plan');
      page.click(page.button('plan-section', { value: status }));
      page.click(page.button('open-meal', { meal: meal.id }));
      assert.equal(page.document.querySelector('[data-purchase]'), null);
      assert.equal(page.document.querySelector('[data-action="complete-meal"]'), null);
      assert.ok(page.button('open-save'));
      page.click(page.button(status === 'completed' ? 'repeat-meal' : 'restore-meal', { meal: meal.id }));
      if (status === 'completed') {
        assert.equal(page.location.hash, '#select');
        assert.deepEqual(page.household(), household);
        page.click(page.button('save-builder'));
        assert.notEqual(activeMeal(page).id, meal.id);
        assert.deepEqual(page.household().meals[0], meal);
        assert.ok(page.read().items.every(item => item.status === 'unchecked'));
      } else {
        assert.equal(activeMeal(page).id, meal.id);
        assert.deepEqual(page.read(), meal.data);
      }
    }
  });

  check('两导航更新 hash 和 aria-current，保持采购且可直接取消勾选', () => {
    const page = loadPage();
    page.purchase('bacon', true);
    const before = page.read(), stored = page.raw(), writes = page.writes();
    for (const route of ['home', 'library']) {
      const button = page.node('tabbar').querySelector(`button[data-tab="${route}"]`);
      assert.equal(button.tagName, 'BUTTON');
      page.click(button.querySelector('svg') || button);
      assert.equal(page.evaluate('activeTab'), route);
      const current = page.node('tabbar').querySelectorAll('[aria-current]').filter(entry => entry.getAttribute('aria-current') !== 'false');
      assert.deepEqual(current.map(entry => entry.dataset.tab), [route]);
      assert.equal(page.node('tabbar').hidden, false);
      assert.ok(page.node('screen-title').textContent.trim());
      assert.deepEqual(page.read(), before);
      assert.equal(page.raw(), stored);
      assert.equal(page.writes(), writes);
    }
    page.purchase('bacon', false);
    assert.equal(item(page.read(), 'bacon').status, 'unchecked');
  });

  check('可达 C 入口：全部餐次与设置为二级页，真实按钮返回所属 Tab', () => {
    const page = loadPage(), before = page.household();
    page.click(page.node('navigation-bar').querySelector('[data-route="plan"]'));
    assert.equal(page.location.hash, '#plan');
    assert.equal(page.history.state.tab, 'home');
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#home');
    page.tab('library');
    page.click(page.node('navigation-bar').querySelector('[data-route="backup"]'));
    assert.equal(page.location.hash, '#backup');
    assert.equal(page.history.state.tab, 'library');
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#library');
    for (const recipe of page.household().recipes) {
      page.click(page.node('library-results').querySelector(`[data-route="recipe-${recipe.id}"]`));
      assert.equal(page.location.hash, `#recipe-${recipe.id}`);
      page.click(page.button('back'));
    }
    assert.deepEqual(page.household(), before);
    assert.equal(page.writes(), 0);
  });

  check('浏览器 back/forward 恢复购物和编辑页面，不写入配方', () => {
    const page = loadPage();
    page.go('shopping');
    page.node('view').scrollTop = 190;
    page.go('recipe-edit');
    const length = page.history.length;
    page.history.back();
    assert.equal(page.location.hash, '#shopping');
    assert.equal(page.node('view').scrollTop, 190);
    page.history.forward();
    assert.equal(page.location.hash, '#recipe-edit');
    assert.equal(page.history.length, length);
    assert.equal(page.writes(), 0);
  });

  check('hash 直达子路由及未知路由回退均不覆盖旧存储', () => {
    for (const hash of ['#shopping', '#recipe-beef', '#backup', '#不存在']) {
      const initial = complete(), page = loadPage(initial, { hash });
      assert.equal(page.location.hash, hash === '#不存在' ? '#home' : hash);
      assert.ok(page.view().trim());
      assert.deepEqual(page.read(), plain(initial));
      assert.equal(page.writes(), 0);
      assert.equal(page.history.length, 1, '初次定位使用 replaceState');
    }
  });

  check('初始 replaceState 失败仍显示子页面，history 均受限时也能返回父页', () => {
    for (const options of [{ replaceError: true }, { replaceError: true, pushError: true }]) {
      const page = loadPage(fresh(), { ...options, hash: '#recipe-edit' });
      assert.equal(page.location.hash, '#recipe-edit');
      assert.equal(page.evaluate('currentRoute'), 'recipe-edit');
      assert.ok(page.node('screen-title').textContent.trim());
      page.click(page.button('back'));
      assert.equal(page.location.hash, '#meal');
      assert.equal(page.evaluate('currentRoute'), 'meal');
      assert.ok(page.node('screen-title').textContent.includes('周末晚餐'));
      assert.deepEqual(page.read(), plain(fresh()));
      assert.equal(page.writes(), 0);
    }
  });

  check('pushState 失败仍渲染新页，hash 回退后按来源栈返回', () => {
    const options = {}, page = loadPage(fresh(), options);
    page.go('plan');
    assert.equal(page.history.state.index, 1);
    options.pushError = true;
    page.go('recipe-edit');
    assert.equal(page.location.hash, '#recipe-edit');
    assert.equal(page.evaluate('currentRoute'), 'recipe-edit');
    assert.ok(page.node('screen-title').textContent.includes('本餐调整'));
    assert.equal(page.evaluate('routeIndex'), 0);
    assert.equal(page.history.state, null);
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#plan');
    assert.equal(page.evaluate('currentRoute'), 'plan');
    assert.equal(page.evaluate('activeTab'), 'home');
    assert.deepEqual(page.read(), plain(fresh()));
    assert.equal(page.writes(), 0);
  });

  check('手动 hashchange 恢复页面并关闭 sheet，同一路由的后续事件不重复渲染', () => {
    const page = loadPage(complete());
    page.location.hash = 'shopping';
    page.emitWindow('hashchange');
    assert.equal(page.evaluate('currentRoute'), 'shopping');
    assert.ok(page.node('shopping-count'));
    page.open('open-add');
    page.input('add-name', '未保存的食材');
    page.location.hash = '#library';
    page.emitWindow('hashchange');
    assert.equal(page.evaluate('currentRoute'), 'library');
    assert.equal(page.node('editor-sheet').open, false);
    const title = page.node('screen-title');
    assert.ok(title.textContent.includes('菜谱'));
    for (const event of ['popstate', 'hashchange']) {
      page.emitWindow(event);
      assert.equal(page.node('screen-title'), title, '同一路由应保留当前 DOM 节点');
    }
    assert.deepEqual(page.read(), plain(complete()));
    assert.equal(page.writes(), 0);
  });

  check('子路由直接打开时 back 回到所属页面，无历史也能返回', () => {
    const page = loadPage(fresh(), { hash: '#recipe-edit' });
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#meal');
    assert.equal(page.writes(), 0);
    assert.deepEqual(page.read(), plain(fresh()));
  });

  check('打开添加食材 sheet 后 popstate 关闭浮层、丢弃草稿并恢复实际页面', () => {
    const page = loadPage(complete());
    page.go('plan');
    page.open('open-add');
    page.input('add-name', '未保存的食材');
    page.history.back();
    assert.equal(page.location.hash, '#plan');
    assert.equal(page.node('editor-sheet').open, false);
    assert.ok(page.node('screen-title').textContent.includes('全部餐次'));
    assert.equal(page.document.activeElement, page.node('screen-title'));
    assert.deepEqual(page.read(), plain(complete()));
    assert.equal(page.writes(), 0);
  });

  check('两 Tab 保存各自详情与滚动，重按当前 Tab 保持工作现场', () => {
    const page = loadPage(complete()), before = page.household();
    page.click(page.node('screen-next'));
    page.node('view').scrollTop = 420;
    page.tab('library');
    page.click(page.node('library-results').querySelector('[data-route="recipe-beef"]'));
    page.node('view').scrollTop = 230;
    page.tab('home');
    assert.equal(page.location.hash, '#shopping');
    assert.equal(page.node('view').scrollTop, 420);
    const stack = plain(page.history.state.stack);
    page.tab('home');
    assert.equal(page.location.hash, '#shopping');
    assert.deepEqual(plain(page.history.state.stack), stack);
    page.tab('library');
    assert.equal(page.location.hash, '#recipe-beef');
    assert.equal(page.node('view').scrollTop, 230);
    assert.deepEqual(page.household(), before);
    assert.equal(page.writes(), 0);
  });

  check('所有主 App 路由保留可见 Tab，根页及详情均唯一标记当前来源', () => {
    const page = loadPage(fresh());
    for (const tab of ['home', 'library']) {
      page.go(tab);
      for (const route of [tab, 'meal', 'recipe-beef', 'recipe-broccoli', 'recipe-rice', 'shopping', 'recipe-edit', 'meal-cook', 'cook']) {
        page.go(route);
        assert.equal(page.evaluate('activeTab'), tab, `${route} 应保留 ${tab} 来源`);
        const tabbar = page.node('tabbar');
        assert.equal(tabbar.hidden, false, `${route} 保留 Tab`);
        assert.deepEqual(tabbar.querySelectorAll('button[data-tab]').map(button => button.dataset.tab), ['home', 'library']);
        assert.deepEqual(tabbar.querySelectorAll('[aria-current]').filter(button => button.getAttribute('aria-current') !== 'false').map(button => button.dataset.tab), [tab]);
        assert.ok(page.node('navigation-bar').contains(page.node('screen-title')));
      }
    }
    assert.deepEqual(page.read(), plain(fresh()));
    assert.equal(page.writes(), 0);
  });

  check('跨 tab 返回先弹当前栈，历史上一条属于别的 tab 时不跳走', () => {
    const page = loadPage(fresh());
    page.go('meal');
    page.node('view').scrollTop = 82;
    page.go('recipe-beef');
    page.node('view').scrollTop = 240;
    page.tab('library');
    page.tab('home');
    const length = page.history.length;
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#meal');
    assert.equal(page.evaluate('activeTab'), 'home');
    assert.equal(page.node('view').scrollTop, 82);
    assert.equal(page.history.length, length);
    assert.deepEqual(plain(page.history.state.stack).map(entry => entry.route), ['home', 'meal']);
    assert.equal(page.history.state.tab, 'home');
    assert.equal(page.writes(), 0);
  });

  check('浏览器后退前进恢复 tab 栈和离开时的页面滚动', () => {
    const page = loadPage(fresh());
    page.go('meal');
    page.node('view').scrollTop = 65;
    page.go('recipe-beef');
    page.node('view').scrollTop = 280;
    page.emitWindow('pagehide');
    page.history.back();
    assert.equal(page.location.hash, '#meal');
    assert.equal(page.node('view').scrollTop, 65);
    page.history.forward();
    assert.equal(page.location.hash, '#recipe-beef');
    assert.equal(page.evaluate('activeTab'), 'home');
    assert.equal(page.node('view').scrollTop, 280);
    const title = page.node('screen-title');
    page.emitWindow('hashchange');
    assert.equal(page.node('screen-title'), title);
    assert.equal(page.writes(), 0);
  });

  check('浏览器 popstate 跨 tab 恢复来源上下文和已保存的栈', () => {
    const page = loadPage(fresh());
    page.go('meal');
    page.go('recipe-beef');
    page.node('view').scrollTop = 310;
    page.tab('library');
    page.history.back();
    assert.equal(page.location.hash, '#recipe-beef');
    assert.equal(page.evaluate('activeTab'), 'home');
    assert.equal(page.node('view').scrollTop, 310);
    assert.equal(page.node('tabbar').querySelector('[aria-current="page"]').dataset.tab, 'home');
    page.history.forward();
    assert.equal(page.location.hash, '#library');
    assert.equal(page.evaluate('activeTab'), 'library');
    assert.deepEqual(plain(page.evaluate('tabStacks.home')).map(entry => entry.route), ['home', 'meal', 'recipe-beef']);
    assert.equal(page.writes(), 0);
  });

  check('旧 hash 入口映射到现有路由并建立可返回的父栈', () => {
    for (const [hash, route, tab] of [['#shopping-heading', 'shopping', 'home'], ['#recipe-editor', 'recipe-edit', 'home'], ['#versions-editor', 'library', 'library']]) {
      const page = loadPage(complete(), { hash });
      assert.equal(page.location.hash, `#${route}`);
      assert.equal(page.evaluate('activeTab'), tab);
      assert.equal(page.history.state.tab, tab);
      assert.equal(page.history.state.stack.at(-1).route, route);
      assert.deepEqual(page.read(), plain(complete()));
      assert.equal(page.writes(), 0);
    }
  });

  check('view 滚动更新导航分隔状态，不依赖 window 滚动且不写入配方', () => {
    const page = loadPage(fresh());
    page.go('meal');
    for (const top of [0, 40, 41, 180, 12]) {
      page.node('view').scrollTop = top;
      page.dispatch('scroll', page.node('view'));
      assert.equal(page.node('navigation-bar').getAttribute('data-scrolled'), String(top > 40));
      assert.equal(page.evaluate('window.scrollY'), 0);
    }
    assert.equal(page.writes(), 0);
  });

  check('左边缘横滑返回父页并清理 transform，250ms 内抑制误触点击', () => {
    const page = loadPage(fresh());
    page.go('meal');
    const view = page.node('view'), navigation = page.node('navigation-bar');
    page.dispatch('pointerdown', view, { clientX: 8, clientY: 200 });
    const move = page.dispatch('pointermove', view, { clientX: 128, clientY: 204 });
    assert.equal(move.defaultPrevented, true);
    assert.equal(view.style.transform, 'translateX(120px)');
    assert.equal(navigation.style.transform, view.style.transform);
    page.dispatch('pointerup', view, { clientX: 128, clientY: 204 });
    assert.equal(page.location.hash, '#home');
    assert.equal(view.style.transform, '');
    assert.equal(navigation.style.transform, '');
    assert.equal(view.hasPointerCapture(1), false);
    const meal = page.button('open-meal', { meal: activeMeal(page).id });
    assert.equal(page.click(meal).defaultPrevented, true);
    assert.equal(page.location.hash, '#home');
    page.advance(249);
    assert.equal(page.click(meal).defaultPrevented, true);
    page.advance(1);
    assert.equal(page.writes(), 0, '被抑制的误触不得保存');
    page.click(meal);
    assert.equal(page.location.hash, '#shopping');
    assert.deepEqual(page.read(), plain(fresh()));
    assert.equal(page.legacyRaw(), JSON.stringify(fresh()));
    assert.equal(page.writes(), 0);
  });

  for (const [name, start, move, end, cancel] of [
    ['超出左边缘', { clientX: 25, clientY: 100 }, { clientX: 150, clientY: 100 }, { clientX: 150, clientY: 100 }],
    ['位于视图左侧外部', { clientX: -1, clientY: 100 }, { clientX: 150, clientY: 100 }, { clientX: 150, clientY: 100 }],
    ['右键', { clientX: 8, clientY: 100, button: 2 }, { clientX: 150, clientY: 100 }, { clientX: 150, clientY: 100 }],
    ['恰好80px', { clientX: 8, clientY: 100 }, { clientX: 88, clientY: 100 }, { clientX: 88, clientY: 100 }],
    ['向左拖动', { clientX: 8, clientY: 100 }, { clientX: -100, clientY: 100 }, { clientX: -100, clientY: 100 }],
    ['横向距离不大于纵向1.5倍', { clientX: 8, clientY: 100 }, { clientX: 98, clientY: 160 }, { clientX: 98, clientY: 160 }],
    ['先纵向滚动后横移', { clientX: 8, clientY: 100 }, { clientX: 10, clientY: 130 }, { clientX: 150, clientY: 130 }],
    ['其他pointer', { clientX: 8, clientY: 100 }, { pointerId: 2, clientX: 150, clientY: 100 }, { pointerId: 2, clientX: 150, clientY: 100 }],
    ['pointercancel', { clientX: 8, clientY: 100 }, { clientX: 150, clientY: 100 }, { clientX: 150, clientY: 100 }, true],
  ]) {
    check(`边缘手势忽略${name}，保留当前栈和配方`, () => {
      const page = loadPage(fresh());
      page.go('meal');
      const view = page.node('view'), stack = plain(page.evaluate('tabStacks[activeTab]'));
      page.dispatch('pointerdown', view, start);
      page.dispatch('pointermove', view, move);
      page.dispatch(cancel ? 'pointercancel' : 'pointerup', view, end);
      page.dispatch('pointercancel', view);
      assert.equal(page.location.hash, '#meal');
      assert.equal(view.style.transform, '');
      assert.equal(page.node('navigation-bar').style.transform, '');
      assert.deepEqual(plain(page.evaluate('tabStacks[activeTab]')), stack);
      assert.deepEqual(page.read(), plain(fresh()));
      assert.equal(page.writes(), 0);
    });
  }

  check('根页、文本输入和打开 sheet 时不启动边缘返回', () => {
    const page = loadPage(fresh());
    const attempt = target => {
      page.dispatch('pointerdown', target, { clientX: 8, clientY: 200 });
      page.dispatch('pointermove', target, { clientX: 140, clientY: 200 });
      page.dispatch('pointerup', target, { clientX: 140, clientY: 200 });
    };
    attempt(page.node('view'));
    assert.equal(page.location.hash, '#home');
    page.go('recipe-edit');
    attempt(page.document.querySelector('textarea[data-notes]'));
    assert.equal(page.location.hash, '#recipe-edit');
    page.open('open-add');
    const route = page.location.hash;
    attempt(page.node('view'));
    assert.equal(page.location.hash, route);
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.node('view').style.transform, '');
    assert.equal(page.writes(), 0);
  });

  check('下拉 sheet 取消添加食材草稿并恢复焦点，随后误触不会重新打开', () => {
    const initial = complete(), page = loadPage(initial), stored = page.raw();
    const trigger = page.open('open-add');
    page.input('add-name', '未保存的食材');
    const dialog = page.node('editor-sheet'), handle = page.node('sheet-view').querySelector('.sheet-handle');
    page.dispatch('pointerdown', handle, { clientY: 100 });
    assert.equal(page.dispatch('pointermove', handle, { clientY: 195 }).defaultPrevented, true);
    assert.equal(dialog.style.transform, 'translateY(95px)');
    page.dispatch('pointerup', handle, { clientY: 195 });
    assert.equal(dialog.open, false);
    assert.equal(dialog.style.transform, '');
    assert.equal(dialog.hasPointerCapture(1), false);
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus);
    assert.equal(page.document.activeElement.isConnected, true);
    assert.deepEqual(page.read(), plain(initial));
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), 0);
    page.click(page.button('open-add'));
    assert.equal(dialog.open, false);
    page.advance();
    page.click(page.button('open-add'));
    assert.equal(dialog.open, true);
    assert.equal(page.node('add-name').value, '');
  });

  check('下拉关闭食材 sheet 保留已自动保存的用量', () => {
    const page = loadPage(fresh());
    page.open('open-item', { item: 'bacon' });
    page.input('quantity-bacon', '2 片');
    const before = page.read(), stored = page.raw(), writes = page.writes();
    const handle = page.node('sheet-view').querySelector('.sheet-handle');
    page.dispatch('pointerdown', handle, { clientY: 100 });
    page.dispatch('pointermove', handle, { clientY: 200 });
    page.dispatch('pointerup', handle, { clientY: 200 });
    assert.equal(page.node('editor-sheet').open, false);
    assert.deepEqual(page.read(), before);
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), writes);
    page.advance();
    page.open('open-item', { item: 'bacon' });
    assert.equal(page.node('quantity-bacon').value, '2 片');
  });

  for (const [name, fromBody, delta, cancel] of [['正文拖动', true, 120, false], ['恰好80px', false, 80, false], ['向上拖动', false, -100, false], ['pointercancel', false, 120, true]]) {
    check(`sheet 忽略${name}，添加食材草稿仍未提交`, () => {
      const page = loadPage(complete());
      page.open('open-add');
      page.input('add-name', '未保存的食材');
      const target = page.node('sheet-view').querySelector(fromBody ? '.sheet-body' : '.sheet-handle');
      page.dispatch('pointerdown', target, { clientY: 100 });
      page.dispatch('pointermove', target, { clientY: 100 + delta });
      page.dispatch(cancel ? 'pointercancel' : 'pointerup', target, { clientY: 100 + delta });
      assert.equal(page.node('editor-sheet').open, true);
      assert.equal(page.node('editor-sheet').style.transform, '');
      assert.equal(page.node('add-name').value, '未保存的食材');
      assert.deepEqual(page.read(), plain(complete()));
      assert.equal(page.writes(), 0);
    });
  }

  check('购物逐项打开待定食材，可选择、持久化并完成关闭', () => {
    const page = loadPage();
    page.go('shopping');
    const trigger = page.button('open-item', { item: 'rosemary' });
    page.click(trigger);
    assert.equal(page.writes(), 0);
    page.choose('rosemary', 'include');
    assert.equal(item(page.saved(), 'rosemary').choice, 'include');
    assert.equal(page.node('editor-sheet').open, true);
    page.closeSheet();
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus);
    assert.equal(page.document.activeElement.isConnected, true);
    page.go('shopping');
    assert.ok(page.document.querySelector('[data-purchase="rosemary"]'));
  });

  check('食材取舍的三按钮更新 aria-pressed，自动保存且保留控件和点击焦点', () => {
    const page = loadPage(complete());
    page.open('open-item', { item: 'bacon' });
    const input = page.node('quantity-bacon');
    const buttons = page.node('sheet-view').querySelectorAll('button[data-action="choice"][data-item="bacon"]');
    assert.deepEqual(buttons.map(button => button.dataset.value), ['include', 'omit', 'pending']);
    assert.equal(page.node('sheet-view').querySelector('select[data-field="choice"]'), null);
    for (const value of ['omit', 'pending', 'include']) {
      const target = page.button('choice', { item: 'bacon', value });
      page.click(target);
      assert.equal(page.document.activeElement, target);
      assert.equal(target.isConnected, true);
      assert.equal(page.node('quantity-bacon'), input);
      assert.equal(input.disabled, value === 'omit');
      for (const button of buttons) assert.equal(button.getAttribute('aria-pressed'), String(button.dataset.value === value));
      assert.equal(item(page.saved(), 'bacon').choice, value);
      assert.equal(item(page.saved(), 'bacon').status, 'unchecked');
      assert.equal(page.saved().reviewed, false);
    }
    assert.equal(page.writes(), 3);
  });

  check('逐项待定材料有三种选择，仅更新当前项的取舍和 aria 状态', () => {
    const page = loadPage(fresh());
    for (const entry of page.read().items.filter(entry => entry.choice === 'pending')) {
      page.go('shopping');
      page.click(page.button('open-item', { item: entry.id }));
      const buttons = page.node('sheet-view').querySelectorAll(`button[data-action="choice"][data-item="${entry.id}"]`);
      assert.deepEqual(buttons.map(button => button.dataset.value), ['include', 'omit', 'pending']);
      assert.deepEqual(buttons.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.value), ['pending']);
      page.closeSheet();
    }
    page.click(page.button('open-item', { item: 'rosemary' }));
    const before = page.read(), target = page.button('choice', { item: 'rosemary', value: 'include' });
    page.click(target);
    assert.equal(page.document.activeElement, target);
    assert.deepEqual(page.read(), plain(invoke('updateItem', before, 'rosemary', { choice: 'include' })));
    assert.equal(target.getAttribute('aria-pressed'), 'true');
    assert.equal(item(page.read(), 'fresh-tomato').choice, 'pending');
    assert.equal(page.node('sheet-view').querySelector('select'), null);
  });

  check('短编辑 sheet 的完成操作位于顶部，正文独立且重新打开重置滚动', () => {
    const page = loadPage(fresh());
    for (const [action, data, done] of [['open-item', { item: 'bacon' }, 'close-sheet'], ['open-item', { item: 'rosemary' }, 'close-sheet'], ['open-save', {}, 'save'], ['open-add', {}, 'add']]) {
      page.node('editor-sheet').scrollTop = 90;
      page.open(action, data);
      const header = page.node('sheet-view').querySelector('.sheet-header'), body = page.node('sheet-view').querySelector('.sheet-body');
      assert.ok(header);
      assert.ok(body);
      assert.equal(header.querySelector('button.sheet-done').dataset.action, done);
      assert.equal(body.contains(page.node('sheet-title')), false);
      assert.equal(page.node('editor-sheet').scrollTop, 0);
      assert.equal(body.scrollTop, 0);
      assert.equal(page.document.activeElement, page.node('sheet-title'));
      page.closeSheet();
    }
    assert.equal(page.writes(), 0);
  });

  check('本餐保存独立常做餐单，当前配方及采购保留并恢复焦点', () => {
    const page = loadPage(complete());
    page.go('meal');
    const before = page.read(), trigger = page.open('open-save');
    page.node('version-name').value = '本餐常做版';
    page.click(page.button('save'));
    assert.deepEqual(page.saved(), before);
    const menu = page.household().menus.find(entry => entry.title === '本餐常做版');
    assert.ok(menu);
    assert.ok(menu.data.items.every(entry => entry.status === 'unchecked'));
    assert.equal(menu.data.notes, before.notes);
    assert.equal(page.node('confirmation-sheet').open, false);
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus);
    assert.equal(page.document.activeElement.isConnected, true);
    assert.equal(page.writes(), 1);
  });

  check('设置为菜谱下二级页，保留备份能力且浏览不改旧用餐人数据', () => {
    const initial = loadPage().household();
    initial.guests = [{ id: 'old-guest', name: '朋友', avoid: '花生', note: '旧记录' }];
    const page = loadPage(initial, { household: true });
    page.go('library');
    page.click(page.node('navigation-bar').querySelector('[data-route="backup"]'));
    for (const action of ['export', 'import', 'print']) assert.ok(page.button(action));
    assert.equal(page.document.querySelector('[data-action="new-guest"]'), null);
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#library');
    assert.deepEqual(page.household(), initial);
    assert.equal(page.writes(), 0);
  });

  check('菜谱默认看材料，做法分段才展示步骤入口且保留来源 tab', () => {
    const page = loadPage(complete());
    for (const recipe of ['beef', 'broccoli', 'rice']) {
      page.go(`recipe-${recipe}`);
      assert.equal(page.button('recipe-section', { recipe, value: 'ingredients' }).getAttribute('aria-pressed'), 'true');
      assert.equal(page.node('recipe-panel').querySelector('button[data-action="open-cook"]'), null);
      assert.ok(page.node('recipe-panel').querySelector('.row'));
      assert.equal(page.node('recipe-panel').querySelector('button[data-action="open-item"]'), null, '菜谱模板材料只读');
      assert.ok(page.button('plan-recipe', { recipe }));
      page.node('view').scrollTop = 75;
      page.click(page.button('recipe-section', { recipe, value: 'method' }));
      assert.equal(page.button('recipe-section', { recipe, value: 'method' }).getAttribute('aria-pressed'), 'true');
      assert.equal(page.button('recipe-section', { recipe, value: 'ingredients' }).getAttribute('aria-pressed'), 'false');
      assert.equal(page.node('view').scrollTop, 75);
      assert.equal(page.evaluate('activeTab'), 'home');
      const cook = page.node('recipe-panel').querySelector('button[data-action="open-cook"]');
      if (recipe === 'beef') {
        assert.ok(cook);
        page.click(cook);
        assert.equal(page.location.hash, '#cook');
        assert.equal(page.node('tabbar').hidden, false);
        page.click(page.button('back'));
        assert.equal(page.location.hash, '#recipe-beef');
      } else assert.equal(cook, null, '未提供完整做法的菜不能伪造逐步入口');
      page.click(page.button('recipe-section', { recipe, value: 'ingredients' }));
      assert.equal(page.node('recipe-panel').querySelector('button[data-action="open-cook"]'), null);
    }
    assert.deepEqual(page.read(), plain(complete()));
    assert.equal(page.writes(), 0);
  });

  check('连续做法保留原十段文字与独立示意图，阅读末段也不更改配方或自动完成', () => {
    const page = loadPage(complete()), before = page.household();
    page.go('shopping');
    page.click(page.node('screen-next'));
    const recipe = before.recipes.find(recipe => recipe.id === 'beef');
    const sections = page.node('view').querySelectorAll('[data-reader-step]');
    assert.equal(sections.length, 10);
    const drawings = [];
    sections.forEach((section, index) => {
      assert.equal(section.tagName, 'ARTICLE');
      assert.equal(section.querySelector('h2').textContent, recipe.steps[index].title);
      assert.equal(section.querySelector('.cook-description').textContent, recipe.steps[index].text);
      const drawing = section.querySelector('svg');
      assert.ok(drawing);
      assert.ok(drawing.getAttribute('aria-label'));
      drawings.push(section.innerHTML || section.children.map(child => child.textContent).join(''));
    });
    assert.equal(new Set(drawings).size, 10);
    assert.equal(page.node('view').querySelector('img'), null);
    page.reader(10);
    assert.equal(page.evaluate('cookStep'), 9);
    assert.deepEqual(page.household(), before);
    assert.equal(page.writes(), 0);
  });

  check('尚未提供的西兰花和米饭做法不配虚构步骤图', () => {
    const page = loadPage();
    for (const recipe of ['broccoli', 'rice']) {
      page.go(`recipe-${recipe}`);
      page.click(page.button('recipe-section', { recipe, value: 'method' }));
      assert.equal(page.node('recipe-panel').querySelectorAll('[data-step-illustration]').length, 0);
      assert.match(page.node('recipe-panel').textContent, /做法待补充/);
    }
  });

  check('备份页动态显示存储说明，导入、导出及打印入口可用', () => {
    const page = loadPage(invoke('saveVersion', fresh(), '已有配方'));
    assert.equal(page.document.getElementById('storage-note'), null);
    page.go('backup');
    assert.ok(page.node('view').contains(page.node('storage-note')));
    assert.ok(page.node('storage-note').textContent.trim());
    for (const action of ['export', 'import', 'print']) {
      assert.ok(page.node('view').contains(page.button(action)));
    }
    page.click(page.button('import'));
    assert.equal(page.filePickerClicks(), 1);
    page.click(page.button('print'));
    assert.equal(page.prints(), 1);
    assert.equal(page.writes(), 0);
  });

  check('存储警告直接导航备份页，保留失败写入前的原存储', () => {
    const page = loadPage(fresh(), { writeError: true });
    page.purchase('bacon', true);
    assert.equal(page.node('save-warning').hidden, false);
    const button = page.node('save-warning').querySelector('[data-route="backup"]');
    assert.ok(button, '存储警告应直接指向备份工具');
    const before = page.read(), stored = page.raw(), writes = page.writes();
    page.click(button);
    assert.equal(page.location.hash, '#backup');
    assert.match(page.node('storage-note').textContent, /保存|备份|导出/);
    assert.deepEqual(page.read(), before);
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), writes);
    assert.equal(page.node('save-warning').hidden, false);
  });

  check('关闭通知仅隐藏消息，后续采购继续更新进度且可取消勾选', () => {
    const page = loadPage();
    page.purchase('bacon', true);
    const button = page.document.querySelector('[data-action="dismiss-message"]');
    assert.ok(button, '缺少通知关闭按钮');
    assert.equal(button.tagName, 'BUTTON');
    assert.ok(page.node('message-wrap').contains(button));
    const before = page.read(), stored = page.raw(), writes = page.writes();
    page.click(button);
    assert.equal(page.node('message-wrap').hidden, true);
    assert.deepEqual(page.read(), before);
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), writes);
    assert.equal(page.node('shopping-progress').value, 1);
    page.purchase('celery', true);
    assert.equal(page.node('shopping-progress').value, 2);
    assert.equal(page.document.querySelector('[data-purchase="celery"]').checked, true);
    page.purchase('celery', false);
    assert.equal(item(page.saved(), 'bacon').status, 'bought');
    assert.equal(item(page.saved(), 'celery').status, 'unchecked');
  });

  await checkAsync('合法长度的恶意文本按文本渲染，旧记录及 JSON 导入导出不执行 HTML', async () => {
    const padded = (attack, limit) => attack + '长'.repeat(limit - attack.length);
    const payloads = {
      name: padded('<img src=x onerror=globalThis.pwned=1>\"\'&', 60),
      dish: padded('炖牛肉<img src=x onerror=globalThis.pwned=1>\"\'&', 60),
      quantity: padded('\" autofocus onfocus=globalThis.pwned=1 x=\"<&\'', 80),
      source: padded('<svg onload=globalThis.pwned=1></svg>\"\'&', 250),
      note: padded('<script>globalThis.pwned=1</script>\"\'&', 400),
      notes: padded('</textarea><img src=x onerror=globalThis.pwned=1><script>globalThis.pwned=1</script>\"\'&', 4000),
    };
    const initial = plain(complete());
    const { notes, ...materialPayloads } = payloads;
    Object.assign(item(initial, 'beef'), materialPayloads);
    Object.assign(item(initial, 'rosemary'), materialPayloads, { choice: 'pending' });
    initial.notes = notes;
    const versionName = padded('<img src=x onerror=globalThis.pwned=1>', 60);
    const imported = invoke('saveVersion', initial, versionName);
    const escaped = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    const assertTextOnly = page => {
      const renderings = [];
      const inspect = () => {
        const markup = page.view() + page.sheet();
        renderings.push(markup);
        for (const text of [...Object.values(payloads), versionName]) assert.ok(!markup.includes(text), '恶意文本不得原样插入 HTML');
        for (const selector of ['script', '[onerror]', '[onload]', '[onfocus]', '[autofocus]']) {
          assert.equal(page.document.querySelectorAll(selector).length, 0, `不得生成 ${selector} 节点或属性`);
        }
        assert.equal(page.evaluate('globalThis.pwned'), undefined);
      };
      for (const route of ['home', 'plan', 'meal', 'shopping', 'library', 'profile', 'recipe-beef', 'recipe-broccoli', 'recipe-rice', 'recipe-edit', 'cook', 'backup']) {
        page.go(route);
        inspect();
      }
      page.go('library');
      page.click(page.button('library-section', { value: 'menus' }));
      inspect();
      for (const [action, data] of [['open-item', { item: 'beef' }], ['open-save', {}], ['open-add', {}]]) {
        page.open(action, data);
        inspect();
        if (action === 'open-item') assert.equal(page.node('quantity-beef').getAttribute('value'), payloads.quantity);
      }
      for (const text of [...Object.values(payloads), versionName]) assert.ok(renderings.join('').includes(escaped(text)), '对应页面或 sheet 应保留完整转义文本');
      page.closeSheet();
    };
    const restored = loadPage(imported);
    assert.deepEqual(restored.read(), plain(imported));
    assert.deepEqual(restored.saved(), plain(imported));
    assert.equal(restored.writes(), 0);
    assertTextOnly(restored);
    const page = loadPage();
    await page.import(imported);
    page.confirm();
    const expected = { ...plain(imported), items: plain(imported.items).map(entry => ({ ...entry, status: 'unchecked' })) };
    assert.deepEqual(page.read(), expected);
    assert.deepEqual(page.saved(), expected);
    assertTextOnly(page);
    page.go('backup');
    page.click(page.button('export'));
    assert.equal(page.downloads.length, 1);
    assert.deepEqual(JSON.parse(await page.downloads[0].blob.text()), page.household());
    assert.deepEqual(page.household().meals.find(meal => meal.id === page.household().activeMealId).data, expected);
    page.purchase('beef', true);
    assertTextOnly(page);
    page.go('shopping');
    assert.ok(page.document.querySelector('[data-purchase="beef"]').getAttribute('aria-label').includes(payloads.name));
    assert.deepEqual(loadPage(page.storedHousehold(), { household: true }).household(), page.household());
  });

  check('未输入配方或用量即可购买，checkbox 持久化为 bought', () => {
    const page = loadPage();
    page.purchase('bacon', true);
    const expected = plain(invoke('updateItem', fresh(), 'bacon', { status: 'bought' }));
    assert.deepEqual(page.read(), expected);
    assert.deepEqual(page.saved(), expected);
    assert.equal(item(page.read(), 'bacon').quantity, '');
    assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, true);
    assertPersisted(page);
    assert.equal(page.node('shopping-progress').value, 1);
    assert.equal(summary(page.read()).ready, false);
  });

  check('采购单行保持顺序且所有已备齐项可见，回页及刷新仍可取消', () => {
    const page = loadPage();
    page.go('shopping');
    const order = page.document.querySelectorAll('[data-purchase]').map(node => node.dataset.purchase);
    page.purchase('bacon', true);
    page.go('home'); page.go('shopping');
    assert.deepEqual(page.document.querySelectorAll('[data-purchase]').map(node => node.dataset.purchase), order);
    assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, true);
    assert.equal(page.document.querySelector('[data-action="toggle-prepared"]'), null);
    const reload = loadPage(page.storedHousehold(), { household: true });
    reload.purchase('bacon', false);
    assert.equal(item(reload.saved(), 'bacon').status, 'unchecked');
    assert.equal(reload.node('shopping-progress').value, 0);
  });

  for (const previous of ['unchecked', 'to-buy', 'bought', 'at-home']) {
    check(`旧采购 ${previous} 原样读回，直接勾选及取消仅改一项`, () => {
      const initial = invoke('updateItem', complete(), 'bacon', { status: previous });
      const page = loadPage(initial);
      page.go('shopping');
      assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, ['bought', 'at-home'].includes(previous));
      assert.deepEqual(page.read(), plain(initial));
      assert.equal(page.writes(), 0);
      page.purchase('bacon', true);
      assert.deepEqual(page.read(), plain(invoke('updateItem', initial, 'bacon', { status: 'bought' })));
      page.purchase('bacon', false);
      assert.deepEqual(page.saved(), plain(invoke('updateItem', initial, 'bacon', { status: 'unchecked' })));
      assert.equal(page.writes(), 2);
    });
  }

  check('旧库存 at-home 不被精简页面覆盖，买菜、编辑与关闭空草稿均保持其他项', () => {
    const page = loadPage(complete()), initial = page.read();
    page.purchase('bacon', false);
    page.input('quantity-beef', '800克');
    page.closeSheet();
    const before = page.read(), raw = page.householdRaw(), writes = page.writes();
    page.open('open-add');
    page.input('add-name', '未提交');
    page.closeSheet();
    assert.deepEqual(page.read(), before);
    assert.equal(page.householdRaw(), raw);
    assert.equal(page.writes(), writes);
    assert.deepEqual(before.items.filter(item => !['bacon', 'beef'].includes(item.id)), initial.items.filter(item => !['bacon', 'beef'].includes(item.id)));
    assert.ok(before.items.filter(item => !['bacon', 'beef'].includes(item.id)).every(item => item.status === 'at-home'));
  });

  check('连续采购后直接取消指定项，保留另一项并持久化', () => {
    const page = loadPage();
    page.purchase('bacon', true);
    page.purchase('celery', true);
    page.purchase('celery', false);
    assert.equal(item(page.saved(), 'bacon').status, 'bought');
    assert.equal(item(page.saved(), 'celery').status, 'unchecked');
    assertPersisted(page);
  });

  for (const [name, edit] of [
    ['用量输入', page => page.input('quantity-bacon', '2 片')],
    ['备注输入', page => page.input('notes', '本次保留西芹')],
    ['完成调整', page => page.finishAdjustment()],
    ['取舍修改', page => page.choose('bacon', 'omit')],
    ['相同取舍确认', page => page.choose('bacon', 'include')],
    ['补充材料', page => { page.open('open-add'); page.node('add-name').value = '测试新材料'; page.node('add-dish').value = '周末加菜'; page.click(page.button('add')); }],
  ]) {
    check(`${name}按共享模型更新本餐，持久化不复活旧配方`, () => {
      const page = loadPage();
      page.purchase('bacon', true);
      const originalId = activeMeal(page).id;
      edit(page);
      assertPersisted(page);
      assert.equal(activeMeal(page).id, originalId);
      assert.equal(page.legacyRaw(), JSON.stringify(fresh()));
      assert.equal(invoke('validate', page.read()), true);
    });
  }

  check('quantity 与 notes 输入仍按 MealModel 持久化', () => {
    const page = loadPage();
    page.purchase('bacon', true);
    page.input('quantity-bacon', '2 片');
    page.input('notes', '西芹晚一点加入');
    const expected = invoke('setNotes', invoke('updateItem', fresh(), 'bacon', { quantity: '2 片' }), '西芹晚一点加入');
    assert.deepEqual(page.saved(), plain(expected));
    assert.equal(item(page.read(), 'bacon').status, 'unchecked');
    assert.equal(page.read().reviewed, false);
  });

  for (const choice of ['include', 'omit']) {
    check(`待定材料 ${choice} 沿用 updateItem 并更新采购清单`, () => {
      const page = loadPage();
      page.purchase('bacon', true);
      const before = page.read();
      page.go('shopping');
      page.click(page.button('open-item', { item: 'rosemary' }));
      page.choose('rosemary', choice);
      assert.deepEqual(page.saved(), plain(invoke('updateItem', before, 'rosemary', { choice })));
      assert.equal(summary(page.read()).unresolvedChoices, 4);
      page.go('shopping');
      assert.equal(Boolean(page.document.querySelector('[data-purchase="rosemary"]')), choice === 'include');
      assertPersisted(page);
    });
  }

  check('勾齐当前清单可开始做饭，readiness 仍提示具体缺量与待定', () => {
    const page = loadPage();
    const readyPage = loadPage(complete());
    readyPage.go('shopping');
    const readyMessage = readyPage.node('readiness').textContent;
    for (const entry of page.read().items.filter(entry => entry.choice === 'include')) page.purchase(entry.id, true);
    const totals = summary(page.read());
    assert.equal(totals.bought, 14);
    assert.equal(totals.unchecked, 0);
    assert.equal(totals.missingQuantities, 14);
    assert.equal(totals.unresolvedChoices, 5);
    assert.equal(totals.ready, false);
    assert.equal(page.node('shopping-progress').value, 14);
    assert.match(page.node('shopping-count').textContent, /14\s*\/\s*14/);
    assert.ok(page.node('readiness').textContent.trim());
    assert.notEqual(page.node('readiness').textContent, readyMessage);
    assert.equal(page.node('screen-next').dataset.action, 'start-cooking');
    assert.equal(page.node('screen-next').textContent, '开始做饭');
    assert.match(page.node('readiness').textContent, /用量待补/);
    assert.match(page.node('readiness').textContent, /还没决定/);
    page.finishAdjustment();
    page.go('shopping');
    assert.equal(summary(page.read()).ready, false);
    assert.notEqual(page.node('readiness').textContent, readyMessage);
  });

  check('用量采购齐全时 pending 仍影响 legacy ready，但不阻止开始做饭或强制 reviewed', () => {
    let initial = invoke('updateItem', complete(), 'rosemary', { choice: 'pending' });
    initial = invoke('setReviewed', initial, true);
    const page = loadPage(initial);
    page.go('shopping');
    const readyPage = loadPage(complete());
    readyPage.go('shopping');
    assert.equal(summary(page.read()).unresolvedChoices, 1);
    assert.equal(summary(page.read()).missingQuantities, 0);
    assert.equal(summary(page.read()).unchecked, 0);
    assert.equal(summary(page.read()).ready, false);
    assert.ok(page.node('readiness').textContent.trim());
    assert.notEqual(page.node('readiness').textContent, readyPage.node('readiness').textContent);
    page.click(page.button('open-item', { item: 'rosemary' }));
    page.choose('rosemary', 'omit');
    assert.equal(page.read().reviewed, false);
    assert.equal(summary(page.read()).ready, false);
    page.finishAdjustment();
    assert.equal(page.read().reviewed, false);
    assert.equal(summary(page.read()).ready, false);
    assert.equal(summary(page.read()).unresolvedChoices, 0);
    assert.equal(page.node('screen-next').dataset.action, 'start-cooking');
    assert.deepEqual(page.saved(), page.read());
  });

  check('完整配方取消及重新勾选，ready 与动态文案同步更新', () => {
    const page = loadPage(complete());
    page.go('shopping');
    const readyMessage = page.node('readiness').textContent;
    assert.equal(summary(page.read()).ready, true);
    assert.ok(readyMessage.trim());
    page.purchase('bacon', false);
    assert.equal(summary(page.read()).ready, false);
    assert.ok(page.node('readiness').textContent.trim());
    assert.notEqual(page.node('readiness').textContent, readyMessage);
    assert.equal(page.node('shopping-progress').value, 18);
    page.purchase('bacon', true);
    assert.equal(summary(page.read()).ready, true);
    assert.equal(page.node('readiness').textContent, readyMessage);
    assert.equal(page.node('shopping-progress').value, 19);
  });

  check('旧 localStorage key/schema 恢复全部采购、取舍、用量、备注和版本', () => {
    let initial = invoke('saveVersion', invoke('setNotes', complete(), '旧版本备注'), '旧常用配方');
    initial = invoke('updateItem', initial, 'bacon', { status: 'bought' });
    initial = invoke('updateItem', initial, 'celery', { status: 'to-buy' });
    initial = invoke('updateItem', initial, 'rosemary', { choice: 'pending' });
    const page = loadPage(initial);
    assert.deepEqual(page.read(), plain(initial));
    assert.deepEqual(page.saved(), plain(initial));
    assert.equal(page.writes(), 0, '打开旧记录不得先覆盖存储');
    page.go('shopping');
    assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, true);
    assert.equal(page.document.querySelector('[data-purchase="celery"]').checked, false);
    assert.equal(page.storedHousehold(), undefined);
    assert.equal(page.legacyRaw(), JSON.stringify(initial));
    assert.equal(page.household().menus[0].title, '旧常用配方');
    page.purchase('celery', true);
    const reopened = loadPage(page.storedHousehold(), { household: true, legacy: initial });
    assert.deepEqual(reopened.read(), page.read());
    assert.deepEqual(reopened.household(), page.household());
    assert.equal(reopened.legacyRaw(), JSON.stringify(initial));
    assert.equal(reopened.writes(), 0);
  });

  check('保存本餐保留采购，复做新建餐恢复改法并重置采购', () => {
    const initial = invoke('setReviewed', invoke('setNotes', complete(), '本版保留西芹'), true);
    const page = loadPage(initial);
    page.purchase('bacon', true);
    page.open('open-save');
    page.node('version-name').value = '周末复用版';
    page.click(page.button('save'));
    const savedMenu = page.household().menus[0];
    assert.ok(savedMenu);
    assert.ok(savedMenu.data.items.every(entry => entry.status === 'unchecked'));
    assert.deepEqual(page.read(), plain(invoke('updateItem', initial, 'bacon', { status: 'bought' })));
    assert.equal(item(page.saved(), 'bacon').status, 'bought');
    page.input('quantity-bacon', '9 片');
    page.input('notes', '临时备注');
    page.purchase('celery', true);
    const beforeUse = activeMeal(page);
    page.go('library');
    page.click(page.button('library-section', { value: 'menus' }));
    page.open('new-meal');
    page.click(page.button('builder-section', { value: 'menus' }));
    page.selectBuilder('menu', [savedMenu.id]);
    assert.equal(page.location.hash, '#select');
    page.click(page.button('save-builder'));
    assert.equal(page.node('confirmation-sheet').open, false);
    assert.notEqual(activeMeal(page).id, beforeUse.id);
    assert.deepEqual(page.household().meals.find(meal => meal.id === beforeUse.id), beforeUse);
    assert.deepEqual(page.read(), savedMenu.data);
    assert.equal(item(page.read(), 'bacon').quantity, '1 份');
    assert.equal(item(page.read(), 'celery').choice, 'include');
    assert.equal(page.read().notes, '本版保留西芹');
    assert.equal(page.read().reviewed, true);
    assert.ok(page.read().items.every(entry => entry.status === 'unchecked'));
    assert.equal(page.household().menus.length, 1);
    assert.equal(summary(page.read()).ready, false);
    assertPersisted(page);
  });

  check('采购更新后键盘焦点仍指向当前 checkbox，已备齐行仍可直接操作', () => {
    const page = loadPage(complete());
    page.go('shopping');
    const checkbox = page.document.querySelector('[data-purchase="bacon"]');
    checkbox.focusVisible = true;
    checkbox.focus();
    page.purchase('bacon', false);
    assert.equal(page.document.activeElement, page.document.querySelector('[data-purchase="bacon"]'));
    assert.equal(page.document.activeElement.isConnected, true);
    assert.equal(page.document.querySelector('[data-purchase="bacon"]').hidden, false);
    assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, false);
  });

  check('食材 sheet 的 quantity 自动保存不重建输入框或丢焦点，关闭返回触发器', () => {
    const page = loadPage();
    const trigger = page.open('open-item', { item: 'bacon' });
    const input = page.node('quantity-bacon');
    assert.equal(input.dataset.field, 'quantity');
    assert.equal(input.dataset.item, 'bacon');
    input.focus();
    for (const value of ['2', '2 片']) {
      input.value = value;
      page.dispatch('input', input);
      assert.equal(page.node('quantity-bacon'), input);
      assert.equal(page.document.activeElement, input);
      assert.equal(input.isConnected, true);
      assert.equal(item(page.saved(), 'bacon').quantity, value);
    }
    page.closeSheet();
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus);
    assert.equal(page.document.activeElement.isConnected, true);
    assert.equal(page.document.querySelectorAll('[data-field="quantity"]').filter(element => page.node('view').contains(element)).length, 0);
  });

  check('配方 notes 自动保存不重建 textarea 或丢焦点', () => {
    const page = loadPage();
    page.go('recipe-edit');
    const input = page.document.querySelector('textarea[data-notes]');
    assert.ok(input);
    input.focus();
    for (const value of ['西芹', '西芹晚一点加入']) {
      input.value = value;
      page.dispatch('input', input);
      assert.equal(page.document.querySelector('[data-notes]'), input);
      assert.equal(page.document.activeElement, input);
      assert.equal(page.saved().notes, value);
    }
  });

  check('sheet 原生取消关闭并恢复焦点，取消新增材料不写入配方', () => {
    const page = loadPage();
    const trigger = page.open('open-add');
    page.node('add-name').value = '未提交材料';
    page.node('add-dish').value = '未提交菜品';
    page.dispatch('cancel', page.node('editor-sheet'));
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus);
    assert.equal(page.document.activeElement.isConnected, true);
    assert.deepEqual(page.read(), plain(fresh()));
    assert.equal(page.writes(), 0);
  });

  check('点击 sheet 遮罩关闭浮层并恢复触发器焦点，不写入草稿', () => {
    const page = loadPage();
    const trigger = page.open('open-save');
    page.node('version-name').value = '尚未保存';
    page.click(page.node('editor-sheet'));
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus);
    assert.equal(page.document.activeElement.isConnected, true);
    assert.equal(page.read().versions.length, 0);
    assert.equal(page.writes(), 0);
  });

  for (const [action, command, field] of [['open-add', 'add', 'add-name'], ['open-save', 'save', 'version-name']]) {
    check(`${command} 校验错误在 sheet 内可见，当前数据不损坏`, () => {
      const page = loadPage(complete());
      page.open(action);
      page.node(field).value = '';
      page.click(page.button(command));
      assert.equal(page.node('editor-sheet').open, true);
      assert.equal(page.node('sheet-message').hidden, false);
      assert.ok(page.node('sheet-message').textContent.trim());
      assert.deepEqual(page.read(), plain(complete()));
      assert.equal(page.writes(), 0);
    });
  }

  check('浮层自动保存失败显示 sheet 警告，保留原存储及当前输入焦点', () => {
    const initial = fresh(), page = loadPage(initial, { writeError: true });
    page.open('open-item', { item: 'bacon' });
    const input = page.node('quantity-bacon');
    input.focus();
    input.value = '2 片';
    page.dispatch('input', input);
    assert.equal(page.node('sheet-save-warning').hidden, false);
    assert.match(page.node('sheet-save-warning').textContent, /保存|备份|导出/);
    assert.equal(page.document.activeElement, input);
    assert.equal(item(page.read(), 'bacon').quantity, '2 片');
    assert.deepEqual(page.saved(), plain(initial));
    assert.equal(page.node('editor-sheet').open, true);
    page.closeSheet();
    assert.equal(page.node('save-warning').hidden, false);
  });

  check('cook 使用完整有序段落和本餐材料，锚点阅读不改采购或 reviewed', () => {
    for (const initial of [fresh(), complete()]) {
      const page = loadPage(initial), before = page.household();
      page.go('shopping');
      page.click(page.node('screen-next'));
      const recipe = page.household().recipes.find(recipe => recipe.id === 'beef');
      assert.deepEqual(page.node('view').querySelectorAll('[data-reader-step]').map(node => Number(node.dataset.readerStep)), recipe.steps.map((_, index) => index));
      assert.equal(page.document.querySelector('[data-action="cook-prev"]'), null);
      assert.equal(page.document.querySelector('[data-action="cook-next"]'), null);
      assert.equal(page.document.querySelector('[data-action="finish-view"]'), null);
      for (const paragraph of [1, recipe.steps.length, 3]) {
        page.reader(paragraph, 37);
        assert.equal(page.evaluate('cookStep'), paragraph - 1);
      }
      assert.doesNotMatch(page.node('view').textContent, /再次核对|重新核对/);
      assert.deepEqual(page.household(), before);
      assert.equal(page.writes(), 0);
    }
  });

  await checkAsync('异步导入旧配方及版本迁入家庭结构，重置采购且保留原 key', async () => {
    const page = loadPage();
    page.purchase('bacon', true);
    const before = page.read(), stored = page.raw(), writes = page.writes();
    const imported = invoke('saveVersion', invoke('setNotes', complete(), '导入的改法'), '导入版');
    await page.import(imported);
    assert.deepEqual(page.read(), before);
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), writes, '未确认导入前不能写入');
    assert.equal(page.document.activeElement, page.node('confirmation-title'));
    page.confirm();
    const expected = { ...plain(imported), items: plain(imported.items).map(entry => ({ ...entry, status: 'unchecked' })) };
    assert.deepEqual(page.read(), expected);
    assert.deepEqual(page.saved(), expected);
    assert.equal(page.confirmations.length, 0);
    assert.equal(page.writes(), writes + 1);
    page.go('shopping');
    assert.equal(page.node('shopping-progress').value, 0);
    assert.equal(summary(page.read()).ready, false);
    assertPersisted(page);
    assert.equal(page.household().menus[0].title, '导入版');
    assert.equal(page.legacyRaw(), JSON.stringify(fresh()));
  });

  await checkAsync('导入读取期间打开的 sheet 在确认后关闭，添加食材草稿不进入导入结果', async () => {
    const page = loadPage();
    page.go('backup');
    const imported = complete(), content = JSON.stringify(imported), input = page.node('import-file');
    let finishRead;
    input.value = 'weekend-menu-backup.json';
    input.files = [{ size: Buffer.byteLength(content), text: () => new Promise(resolve => { finishRead = resolve; }) }];
    const importing = page.dispatch('change', input);
    page.open('open-add');
    page.input('add-name', '未保存的食材');
    assert.equal(page.node('editor-sheet').open, true);
    finishRead(content);
    await importing;
    const expected = { ...plain(imported), items: plain(imported.items).map(entry => ({ ...entry, status: 'unchecked' })) };
    assert.equal(page.node('confirmation-sheet').open, true);
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.writes(), 0);
    assert.deepEqual(page.read(), plain(fresh()));
    page.confirm();
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(input.value, '');
    assert.deepEqual(page.read(), expected);
    assert.deepEqual(page.saved(), expected);
    assert.equal(page.writes(), 1);
  });

  await checkAsync('export 备份包含当前采购、配方及版本且不修改状态', async () => {
    const page = loadPage(invoke('saveVersion', complete(), '备份版'));
    page.purchase('bacon', true);
    const before = page.read();
    page.go('backup');
    page.click(page.button('export'));
    assert.equal(page.downloads.length, 1);
    assert.equal(page.downloads[0].filename, 'family-meals-backup.json');
    assert.equal(page.downloads[0].blob.type, 'application/json');
    assert.deepEqual(JSON.parse(await page.downloads[0].blob.text()), page.household());
    assert.equal(page.household().menus[0].title, '备份版');
    assert.deepEqual(page.read(), before);
    assert.deepEqual(page.saved(), before);
  });

  await checkAsync('家庭 v2 JSON 导出导入回环保留菜谱、菜单、朋友和历史餐，只重置待做采购', async () => {
    const fixture = loadPage(invoke('saveVersion', complete(), '周末可复做版')).household();
    fixture.guests = [{ id: 'old-guest', name: '朋友', avoid: '花生过敏', note: '偏清淡' }];
    fixture.meals[0].guestIds = ['old-guest'];
    fixture.meals[0].status = 'completed'; fixture.activeMealId = null;
    const source = loadPage(fixture, { household: true });
    createMeal(source, '下一顿', ['beef', 'rice']);
    source.purchase(source.read().items[0].id, true);
    const before = source.household(), writes = source.writes();
    source.go('backup');
    source.click(source.button('export'));
    assert.equal(source.downloads[0].filename, 'family-meals-backup.json');
    const serialized = await source.downloads[0].blob.text();
    assert.deepEqual(JSON.parse(serialized), before);
    assert.equal(source.writes(), writes);
    const initial = invoke('setNotes', fresh(), '目标浏览器原始记录');
    const target = loadPage(initial), legacy = target.legacyRaw();
    await target.import(serialized);
    assert.deepEqual(target.read(), plain(initial));
    assert.equal(target.storedHousehold(), undefined);
    assert.equal(target.writes(), 0);
    target.confirm();
    const expected = { ...before, meals: before.meals.map(meal => meal.status === 'planned' ? {
      ...meal, data: { ...meal.data, items: meal.data.items.map(entry => ({ ...entry, status: 'unchecked' })) },
    } : meal) };
    assert.deepEqual(target.household(), expected);
    assert.deepEqual(target.storedHousehold(), expected);
    assert.equal(target.legacyRaw(), legacy);
    assert.equal(target.writes(), 1);
    assert.deepEqual(target.household().meals.find(meal => meal.status === 'completed'), before.meals.find(meal => meal.status === 'completed'));
    assert.ok(target.read().items.every(entry => entry.status === 'unchecked'));
    assert.equal(activeMeal(target).status, 'planned');
    const reopened = loadPage(target.storedHousehold(), { household: true, legacy: '{broken' });
    assert.deepEqual(reopened.household(), expected, '有效 v2 优先于旧 key');
    assert.equal(reopened.node('save-warning').hidden, true);
    assert.equal(reopened.legacyRaw(), '{broken');
    assert.equal(reopened.writes(), 0);
  });

  for (const [name, corrupt] of [
    ['悬空 activeMealId', value => { value.activeMealId = 'missing'; }],
    ['无效餐状态', value => { value.meals[0].status = 'bought'; }],
    ['缺失菜谱引用', value => { value.meals[0].recipeIds = ['missing']; }],
    ['菜谱额外执行字段', value => { value.recipes[0].onload = 'alert(1)'; }],
  ]) {
    await checkAsync(`家庭 v2 导入拒绝${name}，保留全部旧家庭记录与存储`, async () => {
      const page = loadPage();
      page.purchase('bacon', true);
      const before = page.household(), raw = page.householdRaw(), writes = page.writes(), invalid = plain(before);
      corrupt(invalid);
      await page.import(invalid);
      assert.equal(page.node('confirmation-sheet').open, false);
      assert.match(page.node('message').textContent, /导入失败/);
      assert.deepEqual(page.household(), before);
      assert.equal(page.householdRaw(), raw);
      assert.equal(page.writes(), writes);
    });
  }

  for (const invalid of ['{broken', { schemaVersion: 2, activeMealId: 'missing', recipes: [], meals: [], menus: [], guests: [] }]) {
    check('损坏 v2 原文保留，不能静默回退旧 key 后覆盖新版', () => {
      const initial = complete(), page = loadPage(invalid, { household: true, legacy: initial });
      const raw = page.householdRaw();
      assert.equal(page.node('save-warning').hidden, false);
      assert.equal(page.writes(), 0);
      page.purchase('bacon', true);
      assert.equal(item(page.read(), 'bacon').status, 'bought');
      assert.equal(page.householdRaw(), raw);
      assert.equal(page.legacyRaw(), JSON.stringify(initial));
      assert.equal(page.writes(), 0);
    });
  }

  for (const [name, content] of [['错误 JSON', '{'], ['错误 schema', {}], ['过大文件', ' '.repeat(32000001)]]) {
    await checkAsync(`${name} 导入被拒，当前配方及存储保持不变`, async () => {
      const page = loadPage();
      page.purchase('bacon', true);
      const before = page.read(), stored = page.raw();
      await page.import(content);
      assert.deepEqual(page.read(), before);
      assert.equal(page.raw(), stored);
      assert.equal(page.confirmations.length, 0, '无效文件应在确认替换前拒绝');
      assert.equal(page.node('confirmation-sheet').open, false);
      assert.match(page.node('message').textContent, /导入失败/);
      assert.equal(page.node('message-wrap').hidden, false);
    });
  }

  for (const cancel of ['button', 'escape', 'backdrop']) {
    await checkAsync(`通过 ${cancel} 取消导入确认保留当前配方、原存储与采购操作`, async () => {
      const page = loadPage(fresh());
      page.purchase('bacon', true);
      const before = page.read(), stored = page.raw(), writes = page.writes();
      await page.import(invoke('saveVersion', complete(), '取消导入版'));
      assert.equal(page.node('confirmation-sheet').open, true);
      assert.deepEqual(page.read(), before);
      assert.equal(page.raw(), stored);
      assert.equal(page.writes(), writes);
      if (cancel === 'button') page.confirm(false);
      else if (cancel === 'escape') page.dispatch('cancel', page.node('confirmation-sheet'));
      else page.click(page.node('confirmation-sheet'));
      assert.equal(page.node('confirmation-sheet').open, false);
      assert.equal(page.node('import-file').value, '', '取消确认也清空文件框，允许再次选择同一文件');
      assert.deepEqual(page.read(), before);
      assert.equal(page.raw(), stored);
      assert.equal(page.writes(), writes);
      assert.equal(item(page.saved(), 'bacon').status, 'bought');
      page.purchase('bacon', false);
      assert.equal(item(page.saved(), 'bacon').status, 'unchecked');
    });
  }

  await checkAsync('导入文件读取失败保留当前配方与存储并显示失败消息', async () => {
    const page = loadPage(complete());
    page.go('backup');
    const before = page.read(), stored = page.raw();
    const input = page.node('import-file');
    input.files = [{ size: 100, text: async () => { throw new Error('read failed'); } }];
    await page.dispatch('change', input);
    assert.deepEqual(page.read(), before);
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), 0);
    assert.match(page.node('message').textContent, /导入失败/);
  });

  await checkAsync('大小刚好上限的合法备份仍可导入并重置采购', async () => {
    const page = loadPage();
    const initial = complete(), serialized = JSON.stringify(initial);
    await page.import(serialized + ' '.repeat(10000000 - Buffer.byteLength(serialized)));
    assert.equal(page.node('confirmation-sheet').open, true);
    assert.equal(page.writes(), 0);
    page.confirm();
    const expected = { ...plain(initial), items: plain(initial.items).map(entry => ({ ...entry, status: 'unchecked' })) };
    assert.deepEqual(page.saved(), expected);
    assert.deepEqual(page.read(), expected);
  });

  for (const action of ['cancel-meal', 'complete-meal']) {
    for (const cancel of ['button', 'escape', 'backdrop']) {
      check(`通过 ${cancel} 取消 ${action} 确认不改变餐状态、配方及采购`, () => {
        const initial = invoke('saveVersion', complete(), '已有版本'), page = loadPage(initial);
        page.purchase('bacon', true);
        const before = page.read(), stored = page.raw(), writes = page.writes();
        const householdBefore = page.household();
        page.open('meal-actions', { meal: activeMeal(page).id });
        const trigger = page.button(action, { meal: activeMeal(page).id });
        page.click(trigger);
        assert.equal(page.node('confirmation-sheet').open, true);
        assert.deepEqual(page.read(), before);
        assert.equal(page.raw(), stored);
        assert.equal(page.writes(), writes, '未确认前不能写入');
        if (cancel === 'button') page.confirm(false);
        else if (cancel === 'escape') page.dispatch('cancel', page.node('confirmation-sheet'));
        else page.click(page.node('confirmation-sheet'));
        assert.equal(page.node('confirmation-sheet').open, false);
        assert.equal(page.document.activeElement, trigger);
        assert.deepEqual(page.read(), before);
        assert.equal(page.raw(), stored);
        assert.equal(page.writes(), writes);
        assert.deepEqual(page.household(), householdBefore);
        assert.equal(page.node('editor-sheet').open, true, '取消确认后仍可继续管理');
        page.closeSheet();
        page.purchase('bacon', false);
        assert.equal(item(page.read(), 'bacon').status, 'unchecked');
      });
    }
  }

  check('本餐保存同名餐单被拒，原餐单不覆盖，改名后可保存', () => {
    const initial = invoke('setNotes', invoke('saveVersion', complete(), '已有版本'), '更新后的改法');
    const page = loadPage(initial), stored = page.raw(), before = page.household();
    page.open('open-save');
    page.node('version-name').value = '已有版本';
    page.click(page.button('save'));
    assert.equal(page.node('confirmation-sheet').open, false);
    assert.equal(page.node('editor-sheet').open, true);
    assert.deepEqual(page.read(), plain(initial));
    assert.equal(page.raw(), stored);
    assert.equal(page.writes(), 0);
    assert.deepEqual(page.household(), before);
    assert.equal(page.node('sheet-message').hidden, false);
    assert.match(page.node('sheet-message').textContent, /同名|覆盖/);
    page.input('version-name', '另一餐单');
    page.click(page.button('save'));
    assert.deepEqual(page.read(), plain(initial));
    assert.deepEqual(page.saved(), page.read());
    assert.equal(page.read().versions.length, 1);
    assert.deepEqual(page.household().menus[0], before.menus[0]);
    assert.equal(page.household().menus.length, 2);
    assert.ok(page.household().menus[1].data.items.every(entry => entry.status === 'unchecked'));
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.writes(), 1);
    assert.equal(page.confirmations.length, 0);
  });

  check('localStorage 写入失败时显示警告，内存采购仍可直接取消且旧 key 保留', () => {
    const initial = fresh();
    const page = loadPage(initial, { writeError: true });
    page.purchase('bacon', true);
    assert.equal(item(page.read(), 'bacon').status, 'bought');
    assert.deepEqual(page.saved(), plain(initial), '写入失败不得破坏原记录');
    assert.equal(page.writes(), 1);
    assert.equal(page.node('save-warning').hidden, false);
    assert.match(page.node('save-warning-text').textContent, /保存|备份|导出/);
    assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, true);
    assert.equal(page.storedHousehold(), undefined);
    assert.equal(page.legacyRaw(), JSON.stringify(initial));
    page.purchase('bacon', false);
    assert.equal(item(page.read(), 'bacon').status, 'unchecked');
    assert.equal(page.node('save-warning').hidden, false);
  });

  await checkAsync('写入失败仍可在备份页导出最新内存记录，并触发未保存离开保护', async () => {
    const initial = fresh(), page = loadPage(initial, { writeError: true });
    page.purchase('bacon', true);
    const before = page.read();
    page.go('backup');
    page.click(page.button('export'));
    assert.equal(page.downloads.length, 1);
    assert.deepEqual(JSON.parse(await page.downloads[0].blob.text()), page.household());
    assert.deepEqual(page.saved(), plain(initial));
    assert.deepEqual(page.read(), before);
    assert.equal(page.node('save-warning').hidden, false);
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    page.emitWindow('beforeunload', event);
    assert.equal(event.prevented, true);
    assert.equal(event.returnValue, '');
  });

  for (const [name, initial, options] of [
    ['读取抛错', complete(), { readError: true }],
    ['旧记录损坏', '{broken', {}],
    ['旧记录结构错误', { items: [], notes: '', reviewed: true, versions: [] }, {}],
  ]) {
    check(`${name}时主清单显示警告，采购不覆盖旧存储`, () => {
      const page = loadPage(initial, options), stored = page.raw();
      assert.equal(page.node('save-warning').hidden, false);
      assert.match(page.node('save-warning-text').textContent, /原.*数据|原.*记录|读取/);
      page.purchase('bacon', true);
      assert.equal(item(page.read(), 'bacon').status, 'bought');
      assert.equal(page.raw(), stored);
      assert.equal(page.writes(), 0);
      assert.equal(page.node('save-warning').hidden, false);
    });
  }
}

run().catch(error => {
  failures += 1;
  console.error(`FAIL 加载自检: ${error.message}`);
}).finally(() => {
  const stable = JSON.stringify(initialHashes) === JSON.stringify(inputHashes());
  console.log(`INPUT_SHA256 ${JSON.stringify(initialHashes)}`);
  console.log(`INPUT_STABLE ${stable}`);
  if (!stable) { failures += 1; console.error('FAIL 检查期间生产输入发生变化，请在主进程完成后重跑。'); }
  console.log('UNVERIFIED DOM 桩与注入几何只证明逻辑；未验证浏览器视觉、iPhone 和辅助技术。');
  console.log(`RESULT ${passed} PASS / ${failures} FAIL / ${passed + failures} checks`);
  if (failures) process.exitCode = 1;
});
