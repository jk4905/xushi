'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');

const inputs = ['weekend-menu-prototype.html', 'weekend-household-model.js', 'weekend-menu-c.css', 'weekend-menu-prototype-check.cjs'];
const hashes = () => Object.fromEntries(inputs.map(file => [file, createHash('sha256').update(readFileSync(join(__dirname, file))).digest('hex')]));
const beforeHashes = hashes();
const harnessFile = join(__dirname, 'weekend-menu-prototype-check.cjs');
const source = readFileSync(harnessFile, 'utf8');
const start = source.indexOf('  function loadPage(initial, options = {}) {');
const end = source.indexOf('  const stubMarkup =', start);
assert.ok(start > 0 && end > start, '既有 DOM 桩提取边界已变化');
const nodeBoundary = '      return element;\n    };\n    const parse =';
const harness = source.slice(start, end);
assert.equal(harness.split(nodeBoundary).length, 2, '既有 DOM 节点构造边界已变化');
// Keep the optional animation stub local, including nodes created by later renders.
const loadPage = new Function('require', '__dirname', `
  const assert = require('node:assert/strict');
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const vm = require('node:vm');
  const filename = join(__dirname, 'weekend-menu-prototype.html');
  const html = readFileSync(filename, 'utf8');
  const plain = value => JSON.parse(JSON.stringify(value));
  ${harness.replace(nodeBoundary, `      if (options.animate) element.animate = options.animate;\n${nodeBoundary}`)}
  return loadPage;
`)(createRequire(harnessFile), __dirname);

function pageFor(household = loadPage().household(), options = {}) {
  const page = loadPage(household, { household: true, ...options });
  page.evaluate(`
    window.motionTimers = { requests: 0, pending: new Map() };
    window.setTimeout = window.setInterval = (callback, delay, ...args) => {
      const id = ++motionTimers.requests;
      motionTimers.pending.set(id, () => callback(...args));
      return id;
    };
    window.clearTimeout = window.clearInterval = id => motionTimers.pending.delete(id);
  `);
  return page;
}

function releaseTimers(page) {
  page.evaluate(`
    for (let remaining = 100; motionTimers.pending.size; remaining -= 1) {
      if (!remaining) throw new Error('定时器未收敛');
      const [id, callback] = motionTimers.pending.entries().next().value;
      motionTimers.pending.delete(id);
      callback();
    }
  `);
}

function assertUnchanged(page, household, raw, writes) {
  assert.deepEqual(page.household(), household);
  assert.equal(page.householdRaw(), raw);
  assert.equal(page.writes(), writes);
}

function shoppingHintControls(page) {
  page.go('shopping');
  const view = page.node('view'), inputs = view.querySelectorAll('[data-purchase]');
  // Synthetic visibility isolates hint behavior; it does not verify phone layout.
  view.getBoundingClientRect = () => ({ top: 80, height: 500 });
  for (const input of inputs) input.closest('.shopping-row').getBoundingClientRect = () => ({ top: 200, height: 76 });
  return {
    view, inputs,
    hinted: () => view.querySelectorAll('[data-purchase-hint]').map(row => row.querySelector('[data-purchase]').dataset.purchase),
    toggle(input, checked) { input.checked = checked; page.dispatch('change', input); },
  };
}

const checks = [];
const check = (name, action) => checks.push({ name, action });

check('快速切换计划分段：保留按钮与焦点，最终选中项和餐次结果一致', () => {
  const fixture = loadPage().household(), original = fixture.meals[0];
  fixture.meals = ['planned', 'completed', 'cancelled'].map(status => ({ ...structuredClone(original), id: `motion-${status}`, status }));
  fixture.activeMealId = 'motion-planned';
  const page = pageFor(fixture), raw = page.householdRaw();
  page.go('plan');
  const group = page.node('view').querySelector('.segmented');
  const buttons = new Map(group.querySelectorAll('button').map(button => [button.dataset.value, button]));
  for (const status of ['completed', 'cancelled', 'planned', 'cancelled', 'completed']) {
    const button = buttons.get(status);
    page.click(button);
    assert.equal(page.node('view').querySelector('.segmented'), group);
    assert.equal(page.button('plan-section', { value: status }), button, '分段按钮必须仍是原节点');
    assert.equal(button.isConnected, true);
    assert.equal(page.document.activeElement, button, '选中按钮保留焦点');
    assert.deepEqual(group.querySelectorAll('[aria-pressed="true"]').map(node => node.dataset.value), [status]);
    assert.deepEqual(page.node('plan-results').querySelectorAll('[data-action="open-meal"]').map(node => node.dataset.meal), [`motion-${status}`]);
  }
  releaseTimers(page);
  assert.equal(page.location.hash, '#plan');
  assert.equal(page.button('plan-section', { value: 'completed' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(page.node('plan-results').querySelectorAll('[data-action="open-meal"]').map(node => node.dataset.meal), ['motion-completed']);
  assertUnchanged(page, fixture, raw, 0);
});

for (const reduced of [false, true]) {
  check(`采购勾选/取消立即落盘，${reduced ? '减少动态效果' : '普通动态效果'}均不缩放清单`, () => {
    let animations = 0;
    const page = pageFor(undefined, { animate() { animations += 1; return { finished: new Promise(() => {}), cancel() {} }; } });
    page.evaluate(`window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' && ${reduced} });`);
    const expected = page.household();
    const item = expected.meals.find(meal => meal.id === expected.activeMealId).data.items.find(item => item.id === 'bacon');
    for (const [index, checked] of [true, false, true, false].entries()) {
      page.purchase('bacon', checked);
      item.status = checked ? 'bought' : 'unchecked';
      assert.deepEqual(page.household(), expected);
      assert.deepEqual(page.storedHousehold(), expected);
      assert.equal(page.writes(), index + 1);
      assert.equal(page.document.querySelector('[data-purchase="bacon"]').checked, checked);
    }
    assert.equal(animations, 0, '高频采购只变勾选和底色，不做缩放回弹');
    const raw = page.householdRaw(), writes = page.writes();
    page.click(page.node('navigation-bar').querySelector('[data-action="meal-actions"]'));
    page.click(page.button('cancel-meal', { meal: expected.activeMealId }));
    page.confirm(false);
    page.closeSheet();
    releaseTimers(page);
    assert.equal(page.location.hash, '#shopping');
    assertUnchanged(page, expected, raw, writes);
  });
}

check('原位反复点击同一食材20次：行/焦点不重建，不写滚动位置，数据和计数同步', () => {
  const page = pageFor();
  page.go('shopping');
  const view = page.node('view'), rows = view.querySelectorAll('.shopping-row');
  const checkbox = view.querySelector('[data-purchase="bacon"]');
  const name = checkbox.closest('.shopping-row').querySelector('strong');
  const quantity = checkbox.closest('.shopping-row').querySelector('.quantity');
  const expected = page.household();
  const item = expected.meals.find(meal => meal.id === expected.activeMealId).data.items.find(item => item.id === 'bacon');
  let scrollTop = 640, scrollWrites = 0;
  Object.defineProperty(view, 'scrollTop', { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; scrollWrites += 1; } });
  checkbox.focus();
  for (let index = 0; index < 20; index += 1) {
    const checked = index % 2 === 0;
    checkbox.checked = checked;
    page.dispatch('change', checkbox);
    assert.equal(view.querySelector('[data-purchase="bacon"]'), checkbox, '同一控件原位更新，不重新建行');
    view.querySelectorAll('.shopping-row').forEach((row, position) => assert.equal(row, rows[position]));
    assert.equal(page.document.activeElement, checkbox);
    assert.equal(view.scrollTop, 640);
    assert.equal(scrollWrites, 0, '采购不能通过重设 scrollTop 补偿重绘');
    assert.equal(checkbox.closest('.shopping-row').querySelector('strong'), name);
    assert.equal(checkbox.closest('.shopping-row').querySelector('.quantity'), quantity);
    assert.equal(checkbox.closest('.shopping-row').classList.contains('done'), checked);
    assert.equal(checkbox.closest('.shopping-row').querySelector('.purchase-state').textContent, checked ? '已买到' : '', '未选中时不残留打印或无样式可见的已买文案');
    item.status = checked ? 'bought' : 'unchecked';
    assert.deepEqual(page.household(), expected);
    assert.deepEqual(page.storedHousehold(), expected);
    assert.equal(page.node('shopping-progress').value, checked ? 1 : 0);
    assert.equal(page.writes(), index + 1);
  }
});

check('下一项提示跳过已备齐/不放/待确认，过期只清外观，不改采购、焦点或滚动', () => {
  const fixture = loadPage().household();
  const items = fixture.meals.find(meal => meal.id === fixture.activeMealId).data.items;
  for (const item of items) { item.choice = 'include'; item.status = 'unchecked'; }
  items[1].status = 'at-home'; items[2].status = 'bought'; items[3].choice = 'omit'; items[4].choice = 'pending';
  const page = pageFor(fixture), controls = shoppingHintControls(page), first = controls.inputs[0];
  const target = controls.inputs.find(input => input.dataset.purchase === items[5].id);
  const targetRow = target.closest('.shopping-row'), targetText = targetRow.textContent;
  let scrollWrites = 0, forcedScrolls = 0;
  Object.defineProperty(controls.view, 'scrollTop', { configurable: true, get: () => 640, set: () => { scrollWrites += 1; } });
  for (const input of controls.inputs) input.scrollIntoView = () => { forcedScrolls += 1; };
  first.focus();
  controls.toggle(first, true);
  assert.deepEqual(controls.hinted(), [items[5].id]);
  assert.equal(target.checked, false, '提示不能替用户勾选');
  assert.equal(targetRow.classList.contains('done'), false);
  assert.equal(targetRow.textContent, targetText, '不添加会撑高行的提示文字');
  assert.equal(page.document.activeElement, first);
  const expected = structuredClone(fixture);
  expected.meals.find(meal => meal.id === expected.activeMealId).data.items[0].status = 'bought';
  assert.deepEqual(page.household(), expected);
  assert.deepEqual(page.storedHousehold(), expected);
  const raw = page.householdRaw();
  assert.equal(page.writes(), 1);
  releaseTimers(page);
  assert.deepEqual(controls.hinted(), []);
  assert.equal(page.document.activeElement, first);
  assert.equal(scrollWrites, 0);
  assert.equal(forcedScrolls, 0);
  assertUnchanged(page, expected, raw, 1);
});

check('下一项在屏外或只露出一部分时不提示，勾选末项不回头找，首次进入不提示', () => {
  const page = pageFor(), { view, inputs, hinted, toggle } = shoppingHintControls(page);
  assert.deepEqual(hinted(), []);
  const target = inputs[1].closest('.shopping-row');
  for (const top of [600, 550, 60]) {
    target.getBoundingClientRect = () => ({ top, height: 76 });
    toggle(inputs[0], true);
    assert.deepEqual(hinted(), []);
    toggle(inputs[0], false);
  }
  target.getBoundingClientRect = () => ({ top: 200, height: 76 });
  toggle(inputs.at(-1), true);
  assert.deepEqual(hinted(), []);
  assert.equal(view.querySelectorAll('[data-purchase]').length, inputs.length);
});

check('连续勾选只保留最新提示；旧回调、取消、滚动、浮层、切Tab和离开页面不残留', () => {
  const page = pageFor(), { view, inputs, hinted, toggle } = shoppingHintControls(page);
  toggle(inputs[0], true);
  assert.deepEqual(hinted(), [inputs[1].dataset.purchase]);
  const stale = page.evaluate('motionTimers.pending.get(purchaseHint.timer)');
  toggle(inputs[0], false);
  assert.deepEqual(hinted(), []);
  toggle(inputs[0], true);
  stale();
  assert.deepEqual(hinted(), [inputs[1].dataset.purchase], '旧提示的回调不能清除同一行的新提示');
  toggle(inputs[1], true);
  assert.deepEqual(hinted(), [inputs[2].dataset.purchase]);
  assert.equal(page.evaluate('motionTimers.pending.size'), 1, '不积压提示');
  page.dispatch('scroll', view);
  assert.deepEqual(hinted(), []);
  const renew = () => { toggle(inputs[1], false); toggle(inputs[1], true); assert.deepEqual(hinted(), [inputs[2].dataset.purchase]); };
  renew(); page.emitWindow('resize'); assert.deepEqual(hinted(), []);
  renew(); page.emitWindow('pagehide'); assert.deepEqual(hinted(), []);
  renew(); page.open('open-add'); assert.deepEqual(hinted(), []); page.closeSheet();
  const resumed = shoppingHintControls(page);
  resumed.toggle(resumed.inputs[1], false); resumed.toggle(resumed.inputs[1], true);
  const lastRow = resumed.inputs[2].closest('.shopping-row');
  assert.deepEqual(resumed.hinted(), [resumed.inputs[2].dataset.purchase]);
  page.tab('library');
  assert.equal(lastRow.hasAttribute('data-purchase-hint'), false);
  releaseTimers(page);
  page.tab('home');
  assert.equal(page.location.hash, '#shopping');
  assert.deepEqual(page.node('view').querySelectorAll('[data-purchase-hint]'), []);
});

check('减少动态效果不提示；保存失败保留勾选和告警，恢复保存后才允许下一项提示', () => {
  const page = pageFor(), { inputs, hinted, toggle } = shoppingHintControls(page);
  page.evaluate("window.matchMedia = () => ({ matches: true })");
  toggle(inputs[0], true);
  assert.deepEqual(hinted(), []);
  assert.equal(page.writes(), 1);
  page.evaluate("window.matchMedia = () => ({ matches: false }); window.hintSetItem = localStorage.setItem; localStorage.setItem = () => { throw new Error('测试保存失败'); }");
  const saved = page.householdRaw();
  toggle(inputs[1], true);
  assert.deepEqual(hinted(), []);
  assert.equal(inputs[1].checked, true);
  assert.equal(page.node('save-warning').hidden, false);
  assert.equal(page.householdRaw(), saved);
  assert.equal(page.writes(), 1);
  page.evaluate('localStorage.setItem = hintSetItem');
  toggle(inputs[2], true);
  assert.deepEqual(hinted(), [inputs[3].dataset.purchase]);
  assert.equal(page.node('save-warning').hidden, true);
  assert.deepEqual(page.storedHousehold(), page.household());
  assert.equal(page.writes(), 2);
  releaseTimers(page);
  assert.equal(page.writes(), 2, '提示到期不能补写采购记录');
});

check('可视视口滚动不把采购焦点滚入屏幕；仅键盘 resize 照顾文字输入', () => {
  const listeners = new Map();
  const viewport = { height: 700, offsetTop: 0, addEventListener(type, callback) { listeners.set(type, callback); } };
  const page = pageFor(undefined, { innerHeight: 844, visualViewport: viewport });
  page.go('shopping');
  const checkbox = page.document.querySelector('[data-purchase="bacon"]');
  let checkboxScrolls = 0, inputScrolls = 0;
  checkbox.scrollIntoView = () => { checkboxScrolls += 1; };
  checkbox.focus();
  for (let index = 0; index < 5; index += 1) {
    listeners.get('scroll')({ type: 'scroll' });
    listeners.get('resize')({ type: 'resize' });
  }
  assert.equal(checkboxScrolls, 0, '采购和浏览器工具栏变化不能启动焦点滚动循环');
  page.open('new-recipe');
  const input = page.node('link-name');
  input.focus();
  input.scrollIntoView = () => { inputScrolls += 1; };
  viewport.height = 480;
  listeners.get('resize')({ type: 'resize' });
  assert.equal(inputScrolls, 1, '键盘出现时仍保护文字输入可见性');
  listeners.get('scroll')({ type: 'scroll' });
  assert.equal(inputScrolls, 1, '滚动事件不再次触发滚动');
  viewport.height = 844;
  listeners.get('resize')({ type: 'resize' });
  assert.equal(inputScrolls, 1, '键盘关闭不强制滚回焦点');
});

check('添加食材保存失败留弹窗和输入，重试成功同步关闭且只保存一次', () => {
  const page = pageFor(), before = page.household(), raw = page.householdRaw();
  page.open('open-add');
  page.input('add-name', '动效回归食材');
  page.input('add-dish', '勃艮第炖牛肉');
  const name = page.node('add-name'), dish = page.node('add-dish');
  page.evaluate(`
    window.motionSetItem = localStorage.setItem;
    window.motionWriteAttempts = 0;
    localStorage.setItem = () => { motionWriteAttempts += 1; throw new Error('测试保存失败'); };
  `);
  page.click(page.button('add'));
  assert.equal(page.evaluate('motionWriteAttempts'), 1);
  assert.equal(page.node('editor-sheet').open, true);
  assert.equal(page.node('add-name'), name);
  assert.equal(page.node('add-dish'), dish);
  assert.equal(name.value, '动效回归食材');
  assert.equal(dish.value, '勃艮第炖牛肉');
  assertUnchanged(page, before, raw, 0);
  page.evaluate('localStorage.setItem = motionSetItem');
  page.click(page.button('add'));
  assert.equal(page.node('editor-sheet').open, false, '未执行任何定时器就已关闭');
  assert.equal(page.evaluate('activeSheet'), null);
  const after = page.household(), meal = after.meals.find(meal => meal.id === after.activeMealId);
  const added = meal.data.items.filter(item => item.name === name.value);
  assert.equal(added.length, 1);
  assert.equal(added[0].dish, dish.value);
  assert.deepEqual(meal.data.items.filter(item => item.id !== added[0].id), before.meals[0].data.items);
  assert.deepEqual(page.storedHousehold(), after);
  assert.equal(page.writes(), 1);
  const savedRaw = page.householdRaw();
  releaseTimers(page);
  assertUnchanged(page, after, savedRaw, 1);
});

check('快速切菜和 Tab：A第3段/B第2段在未执行 debounce、返回与刷新后保持隔离', () => {
  const fixture = loadPage().household();
  fixture.recipes.find(recipe => recipe.id === 'broccoli').steps = [1, 2, 3].map(step => ({ title: `配菜第${step}段`, text: `配菜做法${step}` }));
  let page = pageFor(fixture);
  const raw = page.householdRaw();
  const switchDish = id => page.click(page.node('reader-switches').querySelector(`[data-action="open-cook"][data-recipe="${id}"]`));
  const scroll = (paragraph, offset) => {
    page.node('view').scrollTop = 100 + (paragraph - 1) * 500 + offset;
    page.dispatch('scroll', page.node('view'));
  };
  const assertReader = (id, paragraph, offset) => {
    assert.equal(page.location.hash, '#cook');
    assert.equal(page.evaluate('cookRecipeId'), id);
    assert.equal(page.evaluate('cookingStepFor(cookRecipeId)'), paragraph - 1);
    assert.equal(page.node('view').scrollTop, 100 + (paragraph - 1) * 500 + offset);
    assert.deepEqual(page.node('reader-switches').querySelectorAll('[aria-pressed="true"]').map(node => node.dataset.recipe), [id]);
    assert.deepEqual(page.node('tabbar').querySelectorAll('[aria-current="page"]').map(node => node.dataset.tab), ['home']);
    const recipe = fixture.recipes.find(recipe => recipe.id === id);
    assert.deepEqual(page.node('view').querySelectorAll('[data-reader-step]').map(node => node.querySelector('.cook-description').textContent), recipe.steps.map(step => step.text));
    assert.equal(page.history.state.stack.at(-1).mealId, fixture.activeMealId);
    assertUnchanged(page, fixture, raw, 0);
  };
  page.go('shopping');
  page.click(page.node('screen-next'));
  scroll(3, 41);
  switchDish('broccoli');
  scroll(2, 67);
  const depth = page.history.state.stack.length;
  for (let turn = 0; turn < 3; turn += 1) {
    switchDish('beef'); assertReader('beef', 3, 41);
    page.tab('library'); page.tab('home'); assertReader('beef', 3, 41);
    switchDish('broccoli'); assertReader('broccoli', 2, 67);
    page.tab('library'); page.tab('home'); assertReader('broccoli', 2, 67);
    assert.equal(page.history.state.stack.length, depth);
  }
  page.emitWindow('pagehide');
  const session = page.session();
  releaseTimers(page);
  assertReader('broccoli', 2, 67);
  page = pageFor(fixture, { session, hash: '#cook' });
  assertReader('broccoli', 2, 67);
  switchDish('beef'); assertReader('beef', 3, 41);
  page.go('home');
  page.click(page.node('screen-next'));
  assertReader('beef', 3, 41);
});

check('编辑及确认弹窗打开/取消同步完成，不创建定时器或家庭数据写入', () => {
  const page = pageFor(), before = page.household(), raw = page.householdRaw();
  const timerRequests = page.evaluate('motionTimers.requests');
  const unchanged = () => {
    assert.equal(page.evaluate('motionTimers.requests'), timerRequests);
    assertUnchanged(page, before, raw, 0);
  };
  for (const close of [() => page.closeSheet(), () => page.dispatch('cancel', page.node('editor-sheet')), () => page.click(page.node('editor-sheet'))]) {
    page.open('open-add');
    assert.equal(page.node('editor-sheet').open, true);
    unchanged();
    close();
    assert.equal(page.node('editor-sheet').open, false);
    unchanged();
  }
  page.go('shopping');
  page.click(page.node('screen-next'));
  for (const close of [() => page.confirm(false), () => page.dispatch('cancel', page.node('confirmation-sheet')), () => page.click(page.node('confirmation-sheet'))]) {
    page.click(page.node('screen-next'));
    assert.equal(page.node('confirmation-sheet').open, true);
    unchanged();
    close();
    assert.equal(page.node('confirmation-sheet').open, false);
    assert.equal(page.location.hash, '#cook');
    unchanged();
  }
});

console.log('EXECUTION Node VM + existing DOM stubs; timers held; no browser/HTTP or real user storage');
let failures = 0;
for (const { name, action } of checks) {
  try { action(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${String(error.stack).slice(0, 2000)}`); }
}
const stable = JSON.stringify(beforeHashes) === JSON.stringify(hashes());
console.log(`INPUT_SHA256 ${JSON.stringify(beforeHashes)}`);
console.log(`INPUT_STABLE ${stable}`);
console.log(`RESULT ${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} checks`);
console.log('UNVERIFIED 动画观感、原生 dialog 渲染与真机体验；合成坐标只验证阅读恢复语义。');
if (failures || !stable) process.exitCode = 1;
