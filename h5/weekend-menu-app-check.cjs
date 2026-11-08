'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');

const harnessFile = join(__dirname, 'weekend-menu-prototype-check.cjs');
const harnessSource = readFileSync(harnessFile, 'utf8');
const start = harnessSource.indexOf('  function loadPage(initial, options = {}) {');
const end = harnessSource.indexOf('  const stubMarkup =', start);
assert.ok(start > 0 && end > start, '既有 DOM 桩入口已变化，请核对 prototype-check 与 UX audit 探针。');
const loadPage = new Function('require', '__dirname', `
  const assert = require('node:assert/strict');
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const vm = require('node:vm');
  const filename = join(__dirname, 'weekend-menu-prototype.html');
  const html = readFileSync(filename, 'utf8');
  const plain = value => JSON.parse(JSON.stringify(value));
  ${harnessSource.slice(start, end)}
  return loadPage;
`)(createRequire(harnessFile), __dirname);

const checks = [];
const check = (name, action) => checks.push({ name, action });
const activeMeal = page => page.household().meals.find(meal => meal.id === page.household().activeMealId);
const mealById = (page, id) => page.household().meals.find(meal => meal.id === id);

function controlClock(page) {
  page.evaluate(`
    window.checkClock = { now: 0, nextId: 0, pending: new Map() };
    window.setTimeout = (callback, duration = 0, ...args) => {
      const id = ++checkClock.nextId;
      checkClock.pending.set(id, { at: checkClock.now + Number(duration), callback: () => callback(...args) });
      return id;
    };
    window.clearTimeout = id => checkClock.pending.delete(id);
    window.advanceCheckClock = milliseconds => {
      const target = checkClock.now + milliseconds;
      for (let remaining = 10000; remaining > 0; remaining -= 1) {
        const due = [...checkClock.pending].filter(([, timer]) => timer.at <= target)
          .sort((first, second) => first[1].at - second[1].at || first[0] - second[0])[0];
        if (!due) break;
        checkClock.now = due[1].at;
        checkClock.pending.delete(due[0]);
        due[1].callback();
        if (remaining === 1) throw new Error('测试时钟定时器未能在有限次数内结束');
      }
      checkClock.now = target;
    };
  `);
  return {
    advance: milliseconds => page.evaluate(`advanceCheckClock(${milliseconds})`),
    pending: () => page.evaluate('checkClock.pending.size'),
  };
}

function assertTransientMessage(page, clock, message) {
  const household = page.household(), stored = page.storedHousehold(), writes = page.writes();
  assert.equal(page.node('message').textContent, message);
  assert.equal(page.node('message-wrap').hidden, false);
  clock.advance(2999);
  assert.equal(page.node('message-wrap').hidden, false, '2999ms 时成功提示仍可见');
  assert.equal(page.node('message').textContent, message);
  clock.advance(1);
  assert.equal(page.node('message-wrap').hidden, true, '3000ms 时成功提示自动消失');
  assert.equal(clock.pending(), 0);
  assert.deepEqual(page.household(), household, '提示消失不改变家庭数据');
  assert.deepEqual(page.storedHousehold(), stored);
  assert.equal(page.writes(), writes, '提示消失不触发存储写入');
}

function blockStorageWrites(page) {
  page.evaluate(`
    window.checkStorageWrite = localStorage.setItem;
    window.checkWriteAttempts = 0;
    localStorage.setItem = () => {
      checkWriteAttempts += 1;
      throw new Error('回归：临时阻止写入');
    };
  `);
  return () => page.evaluate('localStorage.setItem = checkStorageWrite');
}


// C migrates overview/next/previous scenarios to full articles and synthetic scroll anchors.
// Removed guest/stock UI remains covered as persisted legacy data in prototype-check.

const plain = value => JSON.parse(JSON.stringify(value));
const readingKey = 'weekend-reading-v1';
const progressKey = 'weekend-cooking-progress-v1';
const navigationKey = 'weekend-navigation-v1';
const draftsKey = 'weekend-recipe-drafts-v1';
const builderKey = 'weekend-builders-v1';
const linkKey = 'weekend-link-draft-v1';

function cookingFixture() {
  const household = loadPage().household();
  household.recipes.find(recipe => recipe.id === 'broccoli').steps = [1, 2, 3].map(step => ({ title: `配菜第${step}段`, text: `真实配菜做法${step}` }));
  return household;
}
function reload(page, hash = page.location.hash) {
  page.emitWindow('pagehide');
  return loadPage(page.household(), { household: true, session: page.session(), hash });
}
function addMeal(page, title, recipeIds) {
  page.open('new-meal');
  page.input('builder-title', title);
  page.selectBuilder('recipe', recipeIds);
  page.click(page.node('screen-next'));
  assert.equal(page.location.hash, '#shopping');
  assert.equal(page.node('editor-sheet').open, false);
  assert.equal(activeMeal(page).title, title);
  return activeMeal(page);
}
function addLink(page, name = '链接菜谱', url = 'https://example.com/recipe') {
  page.open('new-recipe');
  page.input('link-name', name);
  page.input('link-url', url);
  page.click(page.button('save-link'));
  assert.equal(page.node('editor-sheet').open, false);
  return page.household().recipes.find(recipe => recipe.name === name);
}
function editRecipe(page, id) {
  page.go(`recipe-${id}`);
  const next = page.node('screen-next');
  assert.equal(next.dataset.action, 'edit-recipe');
  assert.equal(next.dataset.recipe, id);
  assert.equal(next.hasAttribute('data-route'), false);
  page.click(next);
  const sheet = page.node('sheet-view'), footer = sheet.querySelector('.sheet-footer'), body = sheet.querySelector('.sheet-body');
  assert.equal(footer.parentElement, sheet);
  assert.equal(body.contains(footer), false);
  assert.ok(footer.querySelector('[data-action="save-recipe"]'));
  assert.ok(footer.querySelector('[data-action="close-sheet"]'));
  for (const field of ['recipe-name', 'recipe-ingredients', 'recipe-steps']) assert.ok(body.contains(page.node(field)));
}
function startCooking(page) {
  page.go('shopping');
  const next = page.node('screen-next');
  assert.equal(next.dataset.action, 'start-cooking');
  assert.equal(next.dataset.route, undefined);
  assert.equal(next.dataset.recipe, undefined);
  assert.equal(next.disabled, false);
  assert.equal(page.node('view').contains(next), false);
  page.click(next);
  assert.equal(page.location.hash, '#cook');
  assert.equal(page.history.state.stack.some(entry => entry.route === 'meal-cook'), false);
}
function switchDish(page, id) {
  const target = page.node('reader-switches').querySelector(`[data-action="open-cook"][data-recipe="${id}"]`);
  assert.ok(target, '真实逐菜切换按钮');
  page.click(target);
}
function assertReader(page, id, paragraph = 1, offset = 0) {
  assert.equal(page.location.hash, '#cook');
  assert.equal(page.evaluate('cookRecipeId'), id);
  const recipe = page.household().recipes.find(recipe => recipe.id === id);
  const sections = page.node('view').querySelectorAll('[data-reader-step]');
  assert.equal(sections.length, recipe.steps.length);
  sections.forEach((section, index) => {
    assert.equal(section.tagName, 'ARTICLE');
    assert.equal(section.id, `reading-${id}-${index}`);
    assert.equal(Number(section.dataset.readerStep), index);
    assert.equal(section.querySelector('h2').textContent, recipe.steps[index].title);
    assert.equal(section.querySelector('.cook-description').textContent, recipe.steps[index].text);
  });
  for (const action of ['cook-prev', 'cook-next', 'finish-view', 'switch-dish']) assert.equal(page.document.querySelector(`[data-action="${action}"]`), null);
  for (const id of ['screen-previous', 'screen-switch']) assert.equal(page.document.getElementById(id), null);
  const meal = mealById(page, page.history.state.stack.at(-1).mealId);
  assert.deepEqual(page.node('reader-switches').querySelectorAll('button').map(button => button.dataset.recipe), meal.recipeIds);
  assert.deepEqual(page.node('reader-switches').querySelectorAll('[aria-pressed="true"]').map(button => button.dataset.recipe), [id]);
  assert.equal(page.node('screen-next').dataset.action, 'complete-meal');
  assert.equal(page.node('screen-next').dataset.meal, meal.id);
  assert.equal(page.node('screen-next').hasAttribute('data-recipe'), false);
  assert.equal(page.node('screen-next').hasAttribute('data-route'), false);
  if (recipe.steps.length) {
    assert.equal(page.evaluate('cookingStepFor(cookRecipeId)'), paragraph - 1);
    // The harness injects fixed coordinates. This checks anchor math, never browser layout.
    assert.equal(page.node('view').scrollTop, paragraph === 1 && !page.evaluate(`readerPositions.has(${JSON.stringify(`${meal.id}:${id}`)})`) ? 0 : 100 + (paragraph - 1) * 500 + offset);
  } else assert.match(page.node('view').textContent, /做法未记录/);
}
function assertPlan(page, status) {
  assert.equal(page.location.hash, '#plan');
  const controls = page.node('view').querySelectorAll('[data-action="plan-section"]');
  assert.deepEqual(controls.map(node => node.dataset.value), ['planned', 'completed', 'cancelled']);
  assert.deepEqual(controls.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.dataset.value), [status]);
  assert.deepEqual(page.node('plan-results').querySelectorAll('[data-action="open-meal"]').map(node => node.dataset.meal).sort(), page.household().meals.filter(meal => meal.status === status).map(meal => meal.id).sort());
}
function assertNoClobber(page, before, raw) {
  assert.deepEqual(page.household(), before);
  assert.equal(page.householdRaw(), raw);
}
function assertPendingFailure(page, clock) {
  assert.equal(page.node('save-warning').hidden, false);
  assert.equal(clock.pending(), 0);
  clock.advance(60000);
  assert.equal(page.node('message-wrap').hidden, false);
  assert.doesNotMatch(page.node('message').textContent, /已保存|已安排|已取消|已记为/);
}

check('共享桩默认显式 v1 fixture，firstUse 真空且真实 URL 构造与 Blob 下载同时可用', async () => {
  const legacy = loadPage();
  assert.ok(legacy.legacyRaw());
  assert.equal(legacy.household().recipes.length, 3);
  const first = loadPage(undefined, { firstUse: true });
  assert.equal(first.legacyRaw(), undefined);
  assert.equal(first.householdRaw(), undefined);
  for (const field of ['meals', 'recipes', 'menus', 'guests']) assert.deepEqual(first.household()[field], []);
  assert.equal(first.writes(), 0);
  assert.equal(first.evaluate('new URL("/a", "https://example.com").href'), 'https://example.com/a');
  first.go('backup'); first.click(first.button('export'));
  assert.deepEqual(JSON.parse(await first.downloads[0].blob.text()), first.household());
});

check('两个 Tab、二级全部餐次与设置、单一屏幕 CTA 和返回语义', () => {
  for (const page of [loadPage(), loadPage(undefined, { firstUse: true })]) {
    assert.deepEqual(page.node('tabbar').querySelectorAll('[data-tab]').map(node => node.dataset.tab), ['home', 'library']);
    assert.equal(page.node('view').querySelector('[data-action="use-menu"]'), null);
    assert.equal(page.node('view').querySelector('[data-action="new-meal"]'), null);
    page.click(page.node('navigation-bar').querySelector('[data-route="plan"]'));
    assert.equal(page.history.state.tab, 'home');
    assertPlan(page, 'planned');
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#home');
    page.tab('library');
    assert.equal(page.document.querySelectorAll('[data-action="new-recipe"]').length, 1);
    page.click(page.node('navigation-bar').querySelector('[data-route="backup"]'));
    assert.equal(page.history.state.tab, 'library');
    assert.equal(page.location.hash, '#backup');
    page.click(page.button('back'));
    assert.equal(page.location.hash, '#library');
    assert.equal(page.writes(), 0);
  }
});

check('首次使用：链接选菜、空购物直接下厨、取消完成保留，再确认完成只记一次', () => {
  const page = loadPage(undefined, { firstUse: true });
  page.click(page.node('screen-next'));
  assert.equal(page.location.hash, '#select');
  assert.equal(page.node('screen-next').disabled, true);
  page.click(page.button('builder-new-recipe'));
  assert.equal(page.evaluate('activeSheet.type'), 'recipe-link');
  page.input('link-name', '葱油拌面'); page.input('link-url', 'https://example.com/noodles');
  page.click(page.button('save-link'));
  assert.equal(page.location.hash, '#select');
  assert.equal(page.node('editor-sheet').open, false);
  assert.equal(page.household().recipes.length, 1);
  assert.equal(page.node('builder-selection-count').textContent, '已选 1 道');
  page.click(page.node('screen-next'));
  assert.equal(page.location.hash, '#shopping');
  assert.equal(page.document.querySelectorAll('[data-purchase]').length, 0);
  assert.equal(activeMeal(page).data.items.length, 0);
  const source = page.node('view').querySelector('a.source-link');
  assert.equal(source.getAttribute('href'), 'https://example.com/noodles');
  startCooking(page);
  assertReader(page, page.household().recipes[0].id);
  assert.equal(page.node('view').querySelector('a.source-link').getAttribute('rel'), 'noopener noreferrer');
  const before = page.household(), raw = page.householdRaw(), writes = page.writes();
  page.click(page.node('screen-next')); page.confirm(false);
  assert.equal(page.document.activeElement, page.node('screen-next'));
  assertNoClobber(page, before, raw);
  page.click(page.node('screen-next')); page.confirm();
  assertPlan(page, 'completed');
  assert.equal(page.household().meals.length, 1);
  assert.equal(page.household().meals[0].status, 'completed');
  assert.equal(page.writes(), writes + 1);
  page.click(page.button('back'));
  assert.equal(page.location.hash, '#home');
  assert.equal(page.node('screen-next').dataset.action, 'new-meal');
});

check('链接规范化去重：重复保存返回同一记录，不覆盖原名与完整编辑内容', () => {
  const page = loadPage();
  const recipe = addLink(page, '第一名字', ' HTTPS://EXAMPLE.COM:443/recipe#part ');
  editRecipe(page, recipe.id);
  page.input('recipe-ingredients', '鸡蛋｜2个'); page.input('recipe-steps', '第一步\n第二步');
  page.click(page.button('save-recipe'));
  const before = page.household(), record = before.recipes.find(entry => entry.id === recipe.id);
  page.open('new-recipe');
  page.input('link-name', '另一个名字'); page.input('link-url', 'https://example.com/recipe#part');
  page.click(page.button('save-link'));
  assert.equal(page.node('editor-sheet').open, false);
  assert.deepEqual(page.household(), before);
  assert.deepEqual(page.household().recipes.filter(entry => entry.sourceUrl === record.sourceUrl), [record]);
});

check('链接保存失败保留输入和选菜草稿，重试只新增一条并只选一次', () => {
  const before = loadPage().household(), page = loadPage(before, { household: true }), raw = page.householdRaw();
  const clock = controlClock(page);
  page.open('new-meal'); page.input('builder-title', '失败后继续'); page.selectBuilder('recipe', ['rice']);
  page.click(page.button('builder-new-recipe'));
  page.input('link-name', '失败重试汤'); page.input('link-url', 'https://example.com/retry');
  const name = page.node('link-name'), url = page.node('link-url');
  const restore = blockStorageWrites(page);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    page.click(page.button('save-link'));
    assert.equal(page.evaluate('checkWriteAttempts'), attempt);
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.node('link-name'), name); assert.equal(page.node('link-url'), url);
    assert.equal(name.value, '失败重试汤'); assert.equal(url.value, 'https://example.com/retry');
    assertNoClobber(page, before, raw); assertPendingFailure(page, clock);
  }
  restore(); page.click(page.button('save-link'));
  assert.equal(page.node('editor-sheet').open, false);
  assert.equal(page.household().recipes.length, before.recipes.length + 1);
  assert.equal(page.node('builder-title').value, '失败后继续');
  assert.equal(page.node('builder-selection-count').textContent, '已选 2 道');
  assert.deepEqual(page.household().meals, before.meals);
  assert.equal(page.writes(), 1);
  page.click(page.node('screen-next'));
  assert.equal(activeMeal(page).recipeIds.length, 2);
  assert.equal(new Set(activeMeal(page).recipeIds).size, 2);
});

for (const [url, valid] of [['javascript:alert(1)', false], ['data:text/html,x', false], ['file:///tmp/recipe', false], ['https://user:secret@example.com/a', false], ['https://example.com/a', true]]) {
  check(`链接 URL 信任边界 ${valid ? '接受' : '拒绝'} ${url.split(':')[0]}`, () => {
    const page = loadPage(), before = page.household(), raw = page.householdRaw();
    page.open('new-recipe'); page.input('link-name', 'URL验证'); page.input('link-url', url);
    page.click(page.button('save-link'));
    assert.equal(page.node('editor-sheet').open, !valid);
    if (valid) assert.equal(page.household().recipes.at(-1).sourceUrl, url);
    else {
      assertNoClobber(page, before, raw);
      assert.equal(page.node('link-url').getAttribute('aria-invalid'), 'true');
      assert.equal(page.node('link-url-error').hidden, false);
      assert.equal(page.document.activeElement, page.node('sheet-message'));
    }
  });
}

check('连续阅读 A第3段/B第2段：按钮互切、两 Tab、回首页继续与刷新恢复段落及偏移', () => {
  let page = loadPage(cookingFixture(), { household: true });
  const before = page.household(), writes = page.writes();
  startCooking(page); page.reader(3, 41);
  switchDish(page, 'broccoli'); page.reader(2, 67);
  const depth = page.history.state.stack.length;
  switchDish(page, 'beef'); assertReader(page, 'beef', 3, 41);
  switchDish(page, 'broccoli'); assertReader(page, 'broccoli', 2, 67);
  assert.equal(page.history.state.stack.length, depth);
  page.tab('library'); page.tab('home'); assertReader(page, 'broccoli', 2, 67);
  page = reload(page); assertReader(page, 'broccoli', 2, 67);
  page.go('home');
  assert.equal(page.node('screen-next').textContent, '继续做饭');
  page.click(page.node('screen-next')); assertReader(page, 'broccoli', 2, 67);
  switchDish(page, 'beef'); assertReader(page, 'beef', 3, 41);
  assert.deepEqual(page.household(), before);
  assert.equal(page.writes(), writes);
});

check('本餐食材保留真实用量/不放/待定，展开与阅读位置经切菜、Tab 和刷新恢复', () => {
  const household = cookingFixture(), items = household.meals[0].data.items;
  Object.assign(items.find(item => item.id === 'beef'), { quantity: '900克' });
  items.find(item => item.id === 'bacon').choice = 'omit';
  let page = loadPage(household, { household: true });
  startCooking(page); page.reader(3, 12);
  const details = page.node('view').querySelector('.cook-ingredients');
  assert.equal(details.open, false);
  const rows = details.querySelectorAll('.ingredient-line');
  for (const item of items.filter(item => item.dish === household.recipes[0].name)) {
    const row = rows.find(row => row.querySelector('strong').textContent === item.name);
    assert.ok(row);
    assert.ok(row.textContent.includes(item.quantity || '用量未记录'));
    if (item.choice === 'omit') assert.match(row.textContent, /不放/);
    if (item.choice === 'pending') assert.match(row.textContent, /待定/);
  }
  details.open = true; page.dispatch('toggle', details);
  switchDish(page, 'broccoli'); switchDish(page, 'beef');
  assert.equal(page.node('view').querySelector('.cook-ingredients').open, true);
  page.tab('library'); page.tab('home'); page = reload(page);
  assertReader(page, 'beef', 3, 12);
  assert.equal(page.node('view').querySelector('.cook-ingredients').open, true);
  assert.deepEqual(page.household(), household);
});

check('缺失做法仍可逐菜切换并补充完整编辑，不能虚构段落或自动完成', () => {
  const page = loadPage(), before = page.household();
  startCooking(page); page.reader(4, 15);
  switchDish(page, 'broccoli'); assertReader(page, 'broccoli');
  assert.equal(page.node('view').querySelectorAll('[data-reader-step]').length, 0);
  page.click(page.button('edit-recipe', { recipe: 'broccoli' }));
  page.input('recipe-steps', '烫熟西兰花\n加入蒜末');
  page.click(page.button('save-recipe'));
  assert.equal(page.location.hash, '#cook');
  assert.equal(page.node('view').querySelectorAll('[data-reader-step]').length, 2);
  assert.deepEqual(page.household().meals, before.meals);
  switchDish(page, 'beef'); assertReader(page, 'beef', 4, 15);
});


check('链接草稿取消、原生 Escape、遮罩关闭与刷新保留，成功保存后清空', () => {
  for (const cancel of ['button', 'escape', 'backdrop']) {
    let page = loadPage(), before = page.household();
    page.open('new-recipe');
    page.input('link-name', '以后做的菜'); page.input('link-url', 'https://example.com/later');
    if (cancel === 'button') page.closeSheet();
    else page.dispatch(cancel === 'escape' ? 'cancel' : 'click', page.node('editor-sheet'));
    assert.equal(page.node('editor-sheet').open, false);
    assert.deepEqual(page.household(), before);
    page = reload(page); page.open('new-recipe');
    assert.equal(page.node('link-name').value, '以后做的菜');
    assert.equal(page.node('link-url').value, 'https://example.com/later');
    page.click(page.button('save-link'));
    assert.deepEqual(JSON.parse(page.session()[linkKey]), { name: '', sourceUrl: '' });
    assert.equal(page.household().recipes.length, before.recipes.length + 1);
  }
});

check('链接重复名称、空名与恶意 HTML 保持校验和转义，不覆写原记录', () => {
  const page = loadPage(), before = page.household();
  page.open('new-recipe'); page.input('link-url', 'https://example.com/other');
  page.click(page.button('save-link'));
  assert.equal(page.node('link-name').getAttribute('aria-invalid'), 'true');
  page.input('link-name', before.recipes[0].name); page.click(page.button('save-link'));
  assert.equal(page.node('editor-sheet').open, true);
  assert.deepEqual(page.household(), before);
  const name = '<img src=x onerror=globalThis.pwned=1>';
  page.input('link-name', name); page.click(page.button('save-link'));
  const recipe = page.household().recipes.find(recipe => recipe.name === name);
  assert.ok(recipe);
  page.go(`recipe-${recipe.id}`);
  assert.equal(page.document.querySelector('[onerror]'), null);
  assert.equal(page.document.querySelector('img'), null);
  assert.equal(page.evaluate('globalThis.pwned'), undefined);
  assert.equal(page.node('screen-title').textContent, name);
  assert.deepEqual(page.household().recipes.slice(0, before.recipes.length), before.recipes);
});

check('选菜页保存边界：真实复选框、未选禁用、计数、搜索过滤与可选餐名日期', () => {
  const page = loadPage(), before = page.household();
  page.open('new-meal');
  assert.equal(page.node('editor-sheet').open, false);
  assert.equal(page.node('screen-next').dataset.action, 'save-builder');
  assert.equal(page.node('screen-next').disabled, true);
  assert.equal(page.node('view').contains(page.node('screen-next')), false);
  assert.equal(page.node('view').querySelector('.builder-options').open, false);
  assert.equal(page.document.querySelector('[data-builder-guest]'), null);
  for (const ids of [['beef'], ['beef', 'rice'], [], ['rice']]) {
    page.selectBuilder('recipe', ids);
    assert.equal(page.node('builder-selection-count').textContent, `已选 ${ids.length} 道`);
    assert.equal(page.node('screen-next').disabled, !ids.length);
  }
  page.input('builder-search', '米');
  assert.deepEqual(page.node('view').querySelectorAll('[data-builder-filter]').filter(node => !node.hidden).map(node => node.querySelector('input').dataset.builderRecipe), ['rice']);
  page.input('builder-search', '不存在'); assert.equal(page.node('builder-no-results').hidden, false);
  page.input('builder-date', '2026-10-25');
  assert.deepEqual(page.household(), before);
  page.click(page.node('screen-next'));
  assert.equal(activeMeal(page).title, '米饭');
  assert.equal(activeMeal(page).date, '2026-10-25');
  assert.deepEqual(page.household().meals.slice(0, -1), before.meals);
});

check('选菜与菜谱搜索分段草稿：切 Tab、返回、刷新恢复查询和勾选且未提交不写家庭数据', () => {
  const fixture = cookingFixture();
  fixture.menus = plain(loadPage(fixture, { household: true }).evaluate('HouseholdModel.saveMenu(household, { title: "周末组合", recipeIds: ["beef", "rice"] }).menus'));
  fixture.menus[0].id = 'menu-a';
  let page = loadPage(fixture, { household: true });
  page.tab('library'); page.input('library-search', '培根');
  page.click(page.node('library-results').querySelector('[data-route="recipe-beef"]'));
  page.click(page.button('back'));
  assert.equal(page.node('library-search').value, '培根');
  page.click(page.button('library-section', { value: 'menus' })); page.input('library-search', '周末');
  page.open('new-meal'); page.input('builder-title', '我的草稿'); page.input('builder-date', '2026-10-26');
  page.click(page.button('builder-section', { value: 'menus' })); page.selectBuilder('menu', ['menu-a']);
  page.input('builder-search', '周末');
  page.tab('library');
  assert.equal(page.node('library-search').value, '周末');
  assert.equal(page.button('library-section', { value: 'menus' }).getAttribute('aria-pressed'), 'true');
  page = reload(page); page.tab('home');
  assert.equal(page.location.hash, '#select');
  assert.equal(page.node('builder-title').value, '我的草稿');
  assert.equal(page.node('builder-date').value, '2026-10-26');
  assert.equal(page.node('builder-search').value, '周末');
  assert.equal(page.button('builder-section', { value: 'menus' }).getAttribute('aria-pressed'), 'true');
  assert.equal(page.node('view').querySelector('[data-builder-menu="menu-a"]').checked, true);
  assert.equal(page.node('builder-selection-count').textContent, '已选 2 道');
  assert.deepEqual(page.household(), fixture);
  assert.equal(page.writes(), 0);
});

for (const type of ['meal-new', 'meal-edit', 'menu-new', 'menu-edit']) {
  check(`${type} 全屏保存失败保留原记录和选择，恢复后单次提交且回来源`, () => {
    const fixture = cookingFixture();
    fixture.menus = plain(loadPage(fixture, { household: true }).evaluate('HouseholdModel.saveMenu(household, { title: "原菜单", recipeIds: ["rice"] }).menus'));
    fixture.menus[0].id = 'menu-a';
    const page = loadPage(fixture, { household: true }), clock = controlClock(page), raw = page.householdRaw();
    if (type === 'meal-edit') {
      page.open('meal-actions', { meal: fixture.activeMealId }); page.click(page.button('edit-meal', { meal: fixture.activeMealId }));
    } else if (type === 'menu-edit') {
      page.go('library'); page.click(page.button('library-section', { value: 'menus' }));
      const cards = page.node('library-results').querySelectorAll('[data-action="edit-menu"]');
      assert.equal(cards.length, 1); page.click(cards[0]);
    } else page.open(type === 'meal-new' ? 'new-meal' : 'new-menu');
    page.input('builder-title', '重试后保存'); page.selectBuilder('recipe', ['beef']);
    const restore = blockStorageWrites(page);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      page.click(page.node('screen-next'));
      assert.equal(page.location.hash, '#select');
      assert.equal(page.node('builder-title').value, '重试后保存');
      assert.equal(page.node('view').querySelector('[data-builder-recipe="beef"]').checked, true);
      assert.equal(page.evaluate('checkWriteAttempts'), attempt);
      assertNoClobber(page, fixture, raw); assertPendingFailure(page, clock);
    }
    restore(); page.click(page.node('screen-next'));
    assert.equal(page.writes(), 1);
    assert.deepEqual(page.storedHousehold(), page.household());
    assert.equal(page.household().meals.length, fixture.meals.length + Number(type === 'meal-new'));
    assert.equal(page.household().menus.length, fixture.menus.length + Number(type === 'menu-new'));
    assert.equal(JSON.parse(page.session()[builderKey]).some(([key]) => key === `${type}:${type === 'meal-edit' ? fixture.activeMealId : type === 'menu-edit' ? 'menu-a' : ''}`), false);
    assert.equal(page.location.hash, type === 'meal-new' ? '#shopping' : type === 'meal-edit' ? '#plan' : '#library');
  });
}

for (const [field, value, pattern] of [
  ['recipe-name', '', /菜名/], ['recipe-name', '米饭', /同名/], ['recipe-ingredients', '', /食材/],
  ['recipe-ingredients', '料'.repeat(15001), /材料|食材/], ['recipe-steps', '做'.repeat(2001), /做法|步骤|每步/],
]) {
  check(`完整编辑 ${field} 校验失败保留输入、原餐和菜谱`, () => {
    const page = loadPage(), before = page.household(), raw = page.householdRaw();
    editRecipe(page, 'beef'); page.input(field, value); page.click(page.button('save-recipe'));
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.node(field).value, value);
    assert.equal(page.node(field).getAttribute('aria-invalid'), 'true');
    assert.equal(page.node(`${field}-error`).hidden, false);
    assert.match(page.node('sheet-message').textContent, pattern);
    assert.equal(page.document.activeElement, page.node('sheet-message'));
    assertNoClobber(page, before, raw);
    assert.equal(page.writes(), 0);
  });
}

check('完整编辑失败留层和持久草稿，取消刷新后恢复；重试只更新菜谱且不重建餐次材料', () => {
  const fixture = cookingFixture();
  fixture.recipes[0].sourceUrl = 'https://example.com/beef';
  let page = loadPage(fixture, { household: true }), clock = controlClock(page), raw = page.householdRaw();
  editRecipe(page, 'beef');
  page.input('recipe-name', '新的牛肉名字'); page.input('recipe-ingredients', '牛肉｜800克\n盐｜少许'); page.input('recipe-steps', '新做法1\n新做法2');
  const restore = blockStorageWrites(page);
  page.click(page.button('save-recipe'));
  assertNoClobber(page, fixture, raw); assertPendingFailure(page, clock);
  assert.equal(page.node('editor-sheet').open, true);
  restore(); page.closeSheet(); page = reload(page); editRecipe(page, 'beef');
  assert.equal(page.node('recipe-name').value, '新的牛肉名字');
  assert.equal(page.node('recipe-steps').value, '新做法1\n新做法2');
  page.click(page.button('save-recipe'));
  assert.equal(page.node('editor-sheet').open, false);
  assert.equal(page.household().recipes.length, fixture.recipes.length);
  assert.equal(page.household().recipes[0].sourceUrl, fixture.recipes[0].sourceUrl);
  assert.deepEqual(page.household().meals, fixture.meals);
  assert.equal(page.writes(), 1);
  assert.deepEqual(JSON.parse(page.session()[draftsKey]), []);
});

check('明确放弃编辑草稿需要确认，取消保持输入，确认清草稿但不改原菜谱', () => {
  const page = loadPage(), before = page.household();
  editRecipe(page, 'beef'); page.input('recipe-name', '待丢弃草稿');
  page.click(page.button('discard-recipe-draft')); page.confirm(false);
  assert.equal(page.node('recipe-name').value, '待丢弃草稿');
  assert.equal(page.node('editor-sheet').open, true);
  page.click(page.button('discard-recipe-draft')); page.confirm();
  assert.equal(page.node('editor-sheet').open, false);
  assert.deepEqual(JSON.parse(page.session()[draftsKey]), []);
  editRecipe(page, 'beef');
  assert.equal(page.node('recipe-name').value, before.recipes[0].name);
  assert.deepEqual(page.household(), before);
  assert.equal(page.writes(), 0);
});

check('本餐调整保存失败留页和输入，重试回连续阅读原段落，只重置本项采购', () => {
  const fixture = cookingFixture();
  fixture.meals[0].data.items.forEach(item => { item.status = 'bought'; item.quantity = '1份'; });
  const page = loadPage(fixture, { household: true });
  startCooking(page); page.reader(3, 31);
  page.click(page.node('navigation-bar').querySelector('[data-action="meal-actions"]'));
  page.click(page.node('sheet-view').querySelector('[data-action="open-meal"][data-next="recipe-edit"]'));
  assert.equal(page.node('screen-next').dataset.action, 'finish-adjustment');
  const restore = blockStorageWrites(page), raw = page.householdRaw();
  page.input('quantity-bacon', '4片'); page.closeSheet();
  page.click(page.node('screen-next'));
  assert.equal(page.location.hash, '#recipe-edit');
  assert.equal(page.read().items.find(item => item.id === 'bacon').quantity, '4片');
  assert.equal(page.householdRaw(), raw);
  assert.equal(page.node('save-warning').hidden, false);
  restore(); page.click(page.node('screen-next'));
  assertReader(page, 'beef', 3, 31);
  assert.equal(page.read().items.find(item => item.id === 'bacon').status, 'unchecked');
  assert.deepEqual(page.read().items.filter(item => item.id !== 'bacon'), fixture.meals[0].data.items.filter(item => item.id !== 'bacon'));
  assert.deepEqual(page.storedHousehold(), page.household());
});

for (const action of ['complete-meal', 'cancel-meal']) {
  check(`${action} 确认取消和写入失败保留来源餐/菜/段落，重试只变状态一次`, () => {
    const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
    const clock = controlClock(page), raw = page.householdRaw();
    startCooking(page); switchDish(page, 'broccoli'); page.reader(2, 61);
    const open = () => {
      if (action === 'complete-meal') page.click(page.node('screen-next'));
      else { page.click(page.node('navigation-bar').querySelector('[data-action="meal-actions"]')); page.click(page.button(action, { meal: fixture.activeMealId })); }
    };
    open(); page.confirm(false);
    assertNoClobber(page, fixture, raw);
    page.closeSheet(); assertReader(page, 'broccoli', 2, 61);
    open();
    const restore = blockStorageWrites(page);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      page.click(page.button('confirm-action'));
      assert.equal(page.node('confirmation-sheet').open, true);
      assert.equal(page.button('confirm-action').textContent, '重试保存');
      assert.equal(page.evaluate('checkWriteAttempts'), attempt);
      assertNoClobber(page, fixture, raw);
      assertReader(page, 'broccoli', 2, 61);
    }
    page.confirm(false); assertNoClobber(page, fixture, raw);
    page.closeSheet(); open(); page.click(page.button('confirm-action'));
    restore(); page.click(page.button('confirm-action'));
    assert.equal(page.node('confirmation-sheet').open, false);
    const status = action === 'complete-meal' ? 'completed' : 'cancelled';
    assertPlan(page, status);
    assert.deepEqual(page.household().meals, fixture.meals.map(meal => ({ ...meal, status })));
    assert.equal(page.writes(), 1);
    assert.deepEqual(reload(page).household(), page.household());
    clock.advance(3000);
  });
}


check('A/B 餐同菜阅读隔离，历史恢复 A 时仍保留活跃 B，后续修改只提交 A', () => {
  const page = loadPage(cookingFixture(), { household: true });
  const first = activeMeal(page);
  startCooking(page); page.reader(3, 29);
  const stateA = plain(page.history.state);
  const second = addMeal(page, '餐 B', ['beef', 'broccoli']);
  startCooking(page);
  assert.equal(page.node('view').scrollTop, 0);
  page.reader(2, 53);
  const stateB = plain(page.history.state), raw = page.householdRaw(), writes = page.writes();
  page.history.pushState(stateA, '', '#cook'); page.emitWindow('popstate');
  assertReader(page, 'beef', 3, 29);
  assert.equal(activeMeal(page).id, second.id);
  assert.equal(page.evaluate('currentMeal().id'), first.id);
  assert.equal(page.householdRaw(), raw); assert.equal(page.writes(), writes);
  page.open('open-add'); page.input('add-name', 'A专用食材'); page.input('add-dish', '勃艮第炖牛肉');
  const before = page.household(), stored = page.householdRaw(), restore = blockStorageWrites(page);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    page.click(page.button('add'));
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.node('add-name').value, 'A专用食材');
    assertNoClobber(page, before, stored);
  }
  restore(); page.click(page.button('add'));
  assert.equal(mealById(page, first.id).data.items.filter(item => item.name === 'A专用食材').length, 1);
  assert.deepEqual(mealById(page, second.id), second);
  assert.equal(page.writes(), writes + 1);
  page.history.pushState(stateB, '', '#cook'); page.emitWindow('popstate');
  assertReader(page, 'beef', 2, 53);
  assert.equal(page.evaluate('currentMeal().id'), second.id);
});

check('同餐同菜来自两个 Tab 的旧栈，采用最新阅读锚点而不回退旧步骤', () => {
  const page = loadPage(cookingFixture(), { household: true });
  startCooking(page); page.reader(3, 14);
  page.tab('library'); page.go('meal'); page.go('cook'); page.reader(4, 27);
  page.tab('home'); assertReader(page, 'beef', 4, 27);
  const next = reload(page); assertReader(next, 'beef', 4, 27);
  assert.equal(page.writes(), 0);
});

for (const oldTab of ['plan', 'profile']) {
  check(`旧四 Tab ${oldTab} 会话迁移到两 Tab，恢复二级路由和父栈且不写家庭数据`, () => {
    const fixture = cookingFixture(), id = fixture.activeMealId;
    const stack = oldTab === 'plan' ? [
      { route: 'plan', scroll: 51 }, { route: 'shopping', mealId: id, mealContext: true, scroll: 181 },
      { route: 'cook', mealId: id, mealContext: true, recipeId: 'beef', step: 2, scroll: 1100 },
    ] : [{ route: 'profile', scroll: 0 }, { route: 'backup', scroll: 55 }];
    const entry = { mealPrototype: true, index: 4, tab: oldTab, stack, tabs: { home: [{ route: 'home', scroll: 0 }], library: [{ route: 'library', scroll: 0 }], [oldTab]: stack } };
    const page = loadPage(fixture, { household: true, hash: oldTab === 'plan' ? '#cook' : '#backup', session: { [navigationKey]: JSON.stringify(entry), [progressKey]: JSON.stringify([[`${id}:beef`, 2]]) } });
    const root = oldTab === 'plan' ? 'home' : 'library';
    assert.equal(page.evaluate('activeTab'), root);
    assert.equal(page.node('tabbar').querySelector('[aria-current="page"]').dataset.tab, root);
    page.emitWindow('pagehide');
    assert.equal(page.history.state.tab, root);
    assert.equal(page.history.state.stack[0].route, root);
    if (oldTab === 'plan') {
      assertReader(page, 'beef', 3, 0);
      page.click(page.button('back'));
      assert.equal(page.location.hash, '#shopping');
      assert.equal(page.node('view').scrollTop, 181);
    } else {
      assert.equal(page.location.hash, '#backup');
      page.click(page.button('back'));
      assert.equal(page.location.hash, '#library');
    }
    assert.deepEqual(page.household(), fixture);
    assert.equal(page.writes(), 0);
  });
}

for (const cache of ['{broken', '{}', 'null', JSON.stringify([['bad', -1], ['missing:beef', 3], ['meal-1:deleted', 3]])]) {
  check(`损坏或失效旧阅读缓存安全忽略 ${cache.slice(0, 24)}`, () => {
    const fixture = cookingFixture(), page = loadPage(fixture, { household: true, session: { [progressKey]: cache, [readingKey]: cache } });
    startCooking(page);
    assert.equal(page.evaluate('cookingStepFor("beef")'), 0);
    assert.deepEqual(page.household(), fixture);
    assert.equal(page.writes(), 0);
  });
}

check('混合旧缓存保留合法项，超范围段落夹取，已删除餐菜不会借用活跃餐', () => {
  const fixture = cookingFixture(), id = fixture.activeMealId;
  const session = { [progressKey]: JSON.stringify([['bad', -1], [`${id}:beef`, 999], [`${id}:broccoli`, 1], ['missing:beef', 2]]) };
  const page = loadPage(fixture, { household: true, session });
  startCooking(page); assertReader(page, 'beef', 10);
  switchDish(page, 'broccoli'); assertReader(page, 'broccoli', 2);
  const stale = { mealPrototype: true, index: 2, tab: 'home', stack: [{ route: 'home', scroll: 0 }, { route: 'cook', mealId: 'missing', mealContext: true, recipeId: 'beef', step: 2, scroll: 0 }] };
  const missing = loadPage(fixture, { household: true, hash: '#cook', historyState: stale });
  assert.match(missing.node('view').textContent, /找不到这餐/);
  assert.equal(missing.node('view').querySelector('[data-reader-step]'), null);
  assert.equal(missing.node('view').querySelector('[data-purchase]'), null);
  assert.deepEqual(missing.household(), fixture);
});

check('会话写入失败保留阅读位置与草稿，提示并触发离页保护，恢复存储后可重试', () => {
  const options = { household: true, sessionWriteError: true }, fixture = cookingFixture();
  const page = loadPage(fixture, options);
  startCooking(page); page.reader(3, 35);
  assert.equal(page.node('reading-warning').hidden, false);
  assert.match(page.node('reading-warning').textContent, /暂未保存/);
  let warned = false;
  page.emitWindow('beforeunload', { preventDefault() { warned = true; } });
  assert.equal(warned, true);
  options.sessionWriteError = false;
  page.click(page.button('retry-reading'));
  assert.equal(page.node('reading-warning').hidden, true);
  assertReader(reload(page), 'beef', 3, 35);
  assert.deepEqual(page.household(), fixture);
});

for (const kind of ['link', 'builder', 'recipe']) {
  check(`${kind} 草稿在会话存储故障时保持输入并阻止静默离页`, () => {
    const page = loadPage(undefined, { sessionWriteError: true }), before = page.household();
    if (kind === 'link') { page.open('new-recipe'); page.input('link-name', '未持久化'); }
    if (kind === 'builder') { page.open('new-meal'); page.input('builder-title', '未持久化'); }
    if (kind === 'recipe') { editRecipe(page, 'beef'); page.input('recipe-name', '未持久化'); }
    if (kind !== 'recipe') {
      const warning = page.document.querySelector('[data-task-draft-warning]');
      assert.ok(warning); assert.equal(warning.hidden, false);
      assert.match(warning.textContent, /仅保留在本页|刷新|丢失/);
    }
    let prevented = false;
    page.emitWindow('beforeunload', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(page.household(), before);
    assert.equal(page.writes(), 0);
  });
}

check('导入失败保留两菜阅读位置和编辑/链接/选菜草稿，成功才清旧编辑与阅读缓存', async () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
  const raw = page.householdRaw();
  startCooking(page); page.reader(3, 33); switchDish(page, 'broccoli'); page.reader(2, 44);
  editRecipe(page, 'beef'); page.input('recipe-name', '导入前编辑'); page.closeSheet();
  page.open('new-meal'); page.input('builder-title', '导入前选菜'); page.selectBuilder('recipe', ['rice']);
  page.click(page.button('builder-new-recipe')); page.input('link-name', '导入前链接'); page.input('link-url', 'https://example.com/pending'); page.closeSheet();
  page.go('backup');
  const snapshot = Object.fromEntries([draftsKey, readingKey, progressKey, builderKey, linkKey].map(key => [key, page.session()[key]]));
  const retained = () => {
    assertNoClobber(page, fixture, raw);
    for (const [key, value] of Object.entries(snapshot)) assert.equal(page.session()[key], value, `${key} 失败保留`);
  };
  await page.import('{}'); retained();
  const imported = structuredClone(fixture); imported.meals[0].title = '导入后'; imported.meals[0].data.items[0].status = 'bought';
  await page.import(imported); page.confirm(false); retained();
  await page.import(imported);
  const restore = blockStorageWrites(page);
  page.click(page.button('confirm-action')); retained();
  assert.equal(page.node('confirmation-sheet').open, true);
  restore(); page.confirm();
  assert.equal(page.household().meals[0].title, '导入后');
  assert.ok(page.household().meals[0].data.items.every(item => item.status === 'unchecked'));
  assert.deepEqual(JSON.parse(page.session()[draftsKey]), []);
  assert.deepEqual(JSON.parse(page.session()[builderKey]), []);
  assert.deepEqual(JSON.parse(page.session()[readingKey]), { positions: [], selected: [] });
  assert.equal(JSON.parse(page.session()[linkKey]).name, '导入前链接');
  assert.equal(page.writes(), 1);
  page.go('home'); page.click(page.node('screen-next'));
  assert.equal(page.location.hash, '#shopping');
  startCooking(page);
  assert.equal(page.node('view').scrollTop, 0);
  assert.equal(page.evaluate('cookingStepFor(cookRecipeId)'), 0);
});

check('旧菜谱编辑草稿 base 已变或引用已删时不套用，合法草稿仍可恢复', () => {
  const fixture = cookingFixture();
  const source = loadPage(fixture, { household: true });
  editRecipe(source, 'beef'); source.input('recipe-name', '原base草稿'); source.closeSheet();
  const session = source.session();
  const changed = structuredClone(fixture); changed.recipes[0].name = '外部新版本';
  const page = loadPage(changed, { household: true, session });
  editRecipe(page, 'beef'); assert.equal(page.node('recipe-name').value, '外部新版本');
  assert.deepEqual(page.household(), changed);
  const restored = loadPage(fixture, { household: true, session });
  editRecipe(restored, 'beef'); assert.equal(restored.node('recipe-name').value, '原base草稿');
  assert.deepEqual(restored.household(), fixture);
});

check('数据写入失败保留自动修改内存、原始存储和导出能力，离页保护仍生效', async () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true, writeError: true }), raw = page.householdRaw();
  page.purchase('bacon', true); page.input('quantity-beef', '800克'); page.input('notes', '未落盘的备注');
  assert.equal(page.read().items.find(item => item.id === 'bacon').status, 'bought');
  assert.equal(page.read().items.find(item => item.id === 'beef').quantity, '800克');
  assert.equal(page.read().notes, '未落盘的备注');
  assert.equal(page.householdRaw(), raw);
  assert.equal(page.node('save-warning').hidden, false);
  let prevented = false; page.emitWindow('beforeunload', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  page.go('backup'); page.click(page.button('export'));
  assert.deepEqual(JSON.parse(await page.downloads[0].blob.text()), page.household());
});

check('读取失败不覆盖原 v2 或 v1，显式链接新增和选菜保存均保留草稿且拒绝落盘', () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true, readError: true }), raw = page.householdRaw();
  page.open('new-recipe'); page.input('link-name', '故障期间'); page.input('link-url', 'https://example.com/blocked');
  page.click(page.button('save-link'));
  assert.equal(page.node('editor-sheet').open, true);
  assert.equal(page.node('link-name').value, '故障期间');
  assert.equal(page.householdRaw(), raw); assert.equal(page.writes(), 0);
  page.closeSheet(); page.open('new-meal'); page.selectBuilder('recipe', ['rice']); page.click(page.node('screen-next'));
  assert.equal(page.location.hash, '#select');
  assert.equal(page.householdRaw(), raw); assert.equal(page.writes(), 0);
});

check('成功提示3秒消失，替换/手动关闭取消旧计时，持久错误不自动消失', () => {
  const page = loadPage(), clock = controlClock(page);
  page.evaluate('notify("默认成功")'); assertTransientMessage(page, clock, '默认成功');
  page.evaluate('notify("第一次")'); clock.advance(2000); page.evaluate('notify("第二次")');
  clock.advance(1000); assert.equal(page.node('message').textContent, '第二次'); assert.equal(page.node('message-wrap').hidden, false);
  page.click(page.button('dismiss-message')); assert.equal(clock.pending(), 0);
  page.evaluate('notify("旧定时")'); clock.advance(1000); page.evaluate('notify("错误保留", 0)');
  assert.equal(clock.pending(), 0); clock.advance(60000);
  assert.equal(page.node('message').textContent, '错误保留'); assert.equal(page.node('message-wrap').hidden, false);
});

for (const action of ['link', 'recipe', 'meal', 'menu', 'add', 'save-menu', 'export', 'import']) {
  check(`${action} 真实成功操作只显示短提示，消失不改变记录`, async () => {
    const page = loadPage(), clock = controlClock(page);
    if (action === 'link') addLink(page);
    if (action === 'recipe') { editRecipe(page, 'beef'); page.input('recipe-name', '成功编辑'); page.click(page.button('save-recipe')); }
    if (action === 'meal') addMeal(page, '成功安排', ['rice']);
    if (action === 'menu') { page.open('new-menu'); page.input('builder-title', '成功菜单'); page.selectBuilder('recipe', ['rice']); page.click(page.node('screen-next')); }
    if (action === 'add') { page.open('open-add'); page.input('add-name', '新食材'); page.input('add-dish', '米饭'); page.click(page.button('add')); }
    if (action === 'save-menu') { page.open('open-save'); page.input('version-name', '保存本餐'); page.click(page.button('save')); }
    if (action === 'export') { page.go('backup'); page.click(page.button('export')); }
    if (action === 'import') { await page.import(page.household()); page.confirm(); }
    assert.equal(page.node('editor-sheet').open, false);
    assertTransientMessage(page, clock, page.node('message').textContent);
  });
}

check('表单校验错误清除旧成功计时，仍显示字段错误与焦点且不改记录', () => {
  const page = loadPage(), clock = controlClock(page), before = page.household();
  page.open('new-recipe'); page.evaluate('notify("旧成功")'); clock.advance(1000);
  page.click(page.button('save-link'));
  assert.equal(clock.pending(), 0); clock.advance(60000);
  assert.equal(page.node('sheet-message').hidden, false);
  assert.equal(page.node('link-name-error').hidden, false);
  assert.equal(page.document.activeElement, page.node('sheet-message'));
  assert.deepEqual(page.household(), before);
});


check('浏览器 popstate 在阅读 debounce 前离开仍捕获当前段落，forward 与刷新无回退', () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
  const clock = controlClock(page);
  startCooking(page);
  page.node('view').scrollTop = 1173;
  page.dispatch('scroll', page.node('view'));
  assert.equal(clock.pending(), 1, '滚动保存尚未执行');
  page.history.back();
  assert.equal(page.location.hash, '#shopping');
  page.history.forward();
  assertReader(page, 'beef', 3, 73);
  assertReader(reload(page), 'beef', 3, 73);
  assert.deepEqual(page.household(), fixture);
  assert.equal(page.writes(), 0);
});

check('旧进度只有 B第2段时首页直接恢复 B，不需要再进总览或虚构 A 阅读记录', () => {
  const fixture = cookingFixture(), id = fixture.activeMealId;
  const page = loadPage(fixture, { household: true, session: { [progressKey]: JSON.stringify([[`${id}:broccoli`, 1]]) } });
  assert.equal(page.node('screen-next').textContent, '继续做饭');
  page.click(page.node('screen-next'));
  assertReader(page, 'broccoli', 2);
  assert.equal(page.evaluate(`cookingProgress.has(${JSON.stringify(`${id}:beef`)})`), false);
  assert.deepEqual(page.household(), fixture);
});


check('原菜谱保存保留来源/取舍/备注/步骤标题，解析器材料编号规范化不改原餐', () => {
  const fixture = cookingFixture(); fixture.recipes[0].sourceUrl = 'https://example.com/original';
  const page = loadPage(fixture, { household: true });
  editRecipe(page, 'beef'); page.click(page.button('save-recipe'));
  assert.equal(page.node('editor-sheet').open, false);
  const expected = structuredClone(fixture);
  // The existing shared parser assigns ingredient-N IDs; every user field must survive.
  expected.recipes[0].items.forEach((item, index) => { item.id = `ingredient-${index + 1}`; });
  assert.deepEqual(page.household(), expected);
  assert.deepEqual(page.storedHousehold(), expected);
  assert.deepEqual(page.household().meals, fixture.meals);
  assert.equal(page.writes(), 1);
});

for (const source of ['home', 'shopping', 'plan']) {
  check(`从 ${source} 明确完成写入失败/取消仍回原来源，不能误移到历史或别餐`, () => {
    const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
    page.go(source); page.node('view').scrollTop = 147;
    page.click(page.button('meal-actions', { meal: fixture.activeMealId }));
    page.click(page.button('complete-meal', { meal: fixture.activeMealId }));
    const restore = blockStorageWrites(page), raw = page.householdRaw();
    page.click(page.button('confirm-action'));
    assert.equal(page.node('confirmation-sheet').open, true);
    assert.equal(page.location.hash, `#${source}`);
    assert.equal(page.node('view').scrollTop, 147);
    assertNoClobber(page, fixture, raw);
    page.confirm(false);
    assert.equal(page.location.hash, `#${source}`);
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.document.activeElement, page.button('complete-meal', { meal: fixture.activeMealId }));
    restore(); page.closeSheet();
    assert.deepEqual(page.household(), fixture);
  });
}

for (const status of ['completed', 'cancelled']) {
  check(`恢复 ${status} 写入失败保留历史，重试使用同一餐并保留采购`, () => {
    const fixture = cookingFixture(); fixture.meals[0].status = status; fixture.activeMealId = null;
    fixture.meals[0].data.items[0].status = 'bought';
    const page = loadPage(fixture, { household: true }), raw = page.householdRaw();
    page.go('plan'); page.click(page.button('plan-section', { value: status }));
    page.click(page.button('meal-actions', { meal: fixture.meals[0].id }));
    const restore = blockStorageWrites(page);
    page.click(page.button('restore-meal', { meal: fixture.meals[0].id }));
    assertNoClobber(page, fixture, raw);
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.location.hash, '#plan');
    restore(); page.click(page.button('restore-meal', { meal: fixture.meals[0].id }));
    assert.equal(page.location.hash, '#shopping');
    assert.equal(activeMeal(page).id, fixture.meals[0].id);
    assert.equal(page.household().meals.length, 1);
    assert.deepEqual(page.read(), fixture.meals[0].data);
    assert.equal(page.writes(), 1);
  });
}

check('链接与旧可选字段经 JSON 导出导入重载保留，危险 sourceUrl 导入拒绝且不覆盖', async () => {
  const page = loadPage();
  const recipe = addLink(page, '链接回环', 'https://example.com/recipe?q=%22%3E%3Cscript%3E');
  assert.equal(Object.hasOwn(page.household().recipes.find(entry => entry.id === 'beef'), 'sourceUrl'), false);
  page.go('backup'); page.click(page.button('export'));
  const serialized = await page.downloads[0].blob.text(), fixture = JSON.parse(serialized);
  const target = loadPage(undefined, { firstUse: true }); await target.import(serialized); target.confirm();
  const restored = reload(target);
  assert.deepEqual(restored.household().recipes, fixture.recipes);
  restored.go(`recipe-${recipe.id}`);
  const link = restored.node('view').querySelector('a.source-link');
  assert.equal(link.getAttribute('href'), recipe.sourceUrl);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(restored.document.querySelector('[onerror]'), null);
  const raw = restored.householdRaw(), before = restored.household();
  fixture.recipes.at(-1).sourceUrl = 'javascript:alert(1)';
  await restored.import(fixture);
  assert.equal(restored.node('confirmation-sheet').open, false);
  assertNoClobber(restored, before, raw);
});

check('键盘 viewport 事件发布与 C CSS 相同高度变量，输入和选菜草稿不丢失（无视觉证明）', () => {
  const listeners = new Map();
  const viewport = { height: 500, offsetTop: 0, addEventListener(type, callback) { listeners.set(type, callback); } };
  const page = loadPage(undefined, { innerHeight: 844, visualViewport: viewport });
  page.open('new-meal'); page.input('builder-title', '键盘期间'); page.selectBuilder('recipe', ['rice']);
  page.node('builder-title').focus();
  listeners.get('resize')();
  assert.equal(page.document.querySelector('.app').style['--visual-viewport-height'], '500px');
  assert.equal(page.node('editor-sheet').style['--keyboard-inset'], '344px');
  viewport.height = 460; viewport.offsetTop = 20; listeners.get('scroll')();
  assert.equal(page.document.querySelector('.app').style['--visual-viewport-height'], '460px');
  assert.equal(page.node('editor-sheet').style['--keyboard-inset'], '364px');
  assert.equal(page.node('builder-title').value, '键盘期间');
  assert.equal(page.node('view').querySelector('[data-builder-recipe="rice"]').checked, true);
  assert.match(readFileSync(join(__dirname, 'weekend-menu-c.css'), 'utf8'), /var\(--visual-viewport-height[,)]/);
  assert.equal(page.writes(), 0);
});


for (const destination of ['shopping', 'recipe-edit']) {
  check(`全部餐次非活跃餐菜单进入 ${destination} 明确携带 mealId，失败恢复原上下文`, () => {
    const page = loadPage(cookingFixture(), { household: true }), first = activeMeal(page);
    const second = addMeal(page, '当前另一餐', ['rice']);
    page.purchase('rice', true);
    const secondSaved = activeMeal(page);
    page.go('plan'); page.node('view').scrollTop = 88;
    page.click(page.button('meal-actions', { meal: first.id }));
    const control = page.node('sheet-view').querySelector(`[data-action="open-meal"][data-meal="${first.id}"][data-next="${destination}"]`);
    assert.ok(control, '通过选中餐次的真实菜单动作进入');
    assert.equal(control.hasAttribute('data-route'), false);
    const before = page.household(), raw = page.householdRaw(), previousViewed = page.evaluate('viewedMealId');
    const restore = blockStorageWrites(page);
    page.click(control);
    assertNoClobber(page, before, raw);
    assert.equal(page.evaluate('viewedMealId'), previousViewed);
    assert.equal(page.evaluate('currentMeal().id'), second.id);
    assert.equal(page.node('editor-sheet').open, true);
    assert.equal(page.location.hash, '#plan');
    assert.equal(page.node('view').scrollTop, 88);
    restore(); page.click(control);
    assert.equal(page.location.hash, `#${destination}`);
    assert.equal(page.node('editor-sheet').open, false);
    assert.equal(page.evaluate('currentMeal().id'), first.id);
    assert.equal(activeMeal(page).id, first.id);
    assert.deepEqual(page.read(), first.data);
    assert.deepEqual(mealById(page, second.id), secondSaved);
    if (destination === 'shopping') page.purchase('bacon', true);
    else page.input('notes', '只属于所选餐');
    assert.deepEqual(mealById(page, second.id), secondSaved);
  });
}


check('导入辅助会话存储写入失败原家庭/缓存不变，确认保留，修复后原确认重试一次', async () => {
  const fixture = cookingFixture(), options = { household: true }, page = loadPage(fixture, options);
  startCooking(page); page.reader(3, 23);
  editRecipe(page, 'beef'); page.input('recipe-name', '原有编辑草稿'); page.closeSheet();
  page.open('new-meal'); page.input('builder-title', '原选菜草稿'); page.selectBuilder('recipe', ['rice']);
  const imported = structuredClone(fixture); imported.meals[0].title = '导入的新餐名';
  await page.import(imported);
  const raw = page.householdRaw(), session = page.session(), writes = page.writes();
  options.sessionWriteError = true;
  page.click(page.button('confirm-action'));
  assert.equal(page.node('confirmation-sheet').open, true);
  assert.match(page.node('message').textContent, /导入未完成|暂不能重置/);
  assertNoClobber(page, fixture, raw);
  assert.deepEqual(page.session(), session);
  assert.equal(page.writes(), writes, '缓存无法安全重置时不能先提交家庭数据');
  options.sessionWriteError = false;
  page.confirm();
  assert.equal(page.household().meals[0].title, '导入的新餐名');
  assert.equal(page.writes(), writes + 1);
  assert.deepEqual(page.storedHousehold(), page.household());
});

check('同餐 ID 导入改选菜清空旧 home 阅读栈，首页只开始新菜；旧浏览器历史也校验成员', async () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
  startCooking(page); page.reader(3, 52);
  const stale = plain(page.history.state);
  const imported = plain(page.evaluate(`HouseholdModel.updateMeal(household, ${JSON.stringify(fixture.activeMealId)}, {recipeIds: ['rice']})`));
  imported.recipes.find(recipe => recipe.id === 'rice').steps = [{ title: '淘米', text: '淘米加水' }, { title: '煮饭', text: '按下煮饭键' }];
  await page.import(imported); page.confirm();
  assert.equal(page.location.hash, '#backup');
  assert.deepEqual(plain(page.evaluate('tabStacks.home')).map(entry => entry.route), ['home']);
  assert.deepEqual(plain(page.evaluate('tabStacks.library')).map(entry => entry.route), ['library', 'backup']);
  page.tab('home');
  assert.equal(page.location.hash, '#home');
  assert.equal(page.node('screen-next').textContent, '继续买菜');
  page.click(page.node('screen-next')); assert.equal(page.location.hash, '#shopping');
  startCooking(page);
  assert.equal(page.evaluate('cookRecipeId'), 'rice');
  assert.equal(page.node('view').scrollTop, 0);
  assert.deepEqual(page.node('view').querySelectorAll('.cook-description').map(node => node.textContent), ['淘米加水', '按下煮饭键']);
  assert.equal(page.node('view').querySelector('#reading-beef-0'), null);
  page.go('home');
  page.history.pushState(stale, '', '#cook'); page.emitWindow('popstate');
  assert.equal(page.location.hash, '#cook');
  assert.equal(page.evaluate('cookRecipeId'), 'rice');
  assert.equal(page.node('view').querySelector('#reading-beef-0'), null);
  assert.equal(page.history.state.stack.at(-1).mealId, fixture.activeMealId);
  assert.deepEqual(page.household().meals[0].recipeIds, ['rice']);
});

check('task 草稿写入失败不被菜谱草稿成功掩盖，恢复写入后警告和离页保护清除', () => {
  const page = loadPage(), before = page.household();
  page.open('new-meal');
  page.evaluate(`
    window.originalSessionWrite = sessionStorage.setItem;
    sessionStorage.setItem = (key, value) => {
      if (key === ${JSON.stringify(builderKey)} || key === ${JSON.stringify(linkKey)}) throw new Error('task draft blocked');
      originalSessionWrite(key, value);
    };
  `);
  page.input('builder-title', '不能丢的选菜');
  assert.equal(page.document.querySelector('[data-task-draft-warning]').hidden, false);
  page.tab('library'); editRecipe(page, 'beef'); page.input('recipe-name', '成功暂存的菜谱草稿'); page.closeSheet();
  assert.equal(page.evaluate('draftStorageFailed'), false);
  assert.equal(page.evaluate('taskDraftStorageFailed'), true);
  let prevented = false; page.emitWindow('beforeunload', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  page.tab('home');
  assert.equal(page.location.hash, '#select');
  assert.equal(page.document.querySelector('[data-task-draft-warning]').hidden, false);
  page.evaluate('sessionStorage.setItem = originalSessionWrite');
  page.input('builder-title', '不能丢的选菜，已恢复');
  assert.equal(page.document.querySelector('[data-task-draft-warning]').hidden, true);
  prevented = false; page.emitWindow('beforeunload', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(page.household(), before);
  assert.equal(page.writes(), 0);
});


check('导入在部分辅助缓存已重置后写失败仍回滚，旧读位和未提交草稿完整保留', async () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
  startCooking(page); page.reader(3, 21);
  page.open('new-meal'); page.input('builder-title', '部分失败保留');
  const imported = structuredClone(fixture); imported.meals[0].title = '不能提前提交';
  await page.import(imported);
  const raw = page.householdRaw(), session = page.session();
  page.evaluate(`
    window.originalCacheWrite = sessionStorage.setItem;
    window.failCacheReset = true;
    sessionStorage.setItem = (key, value) => {
      if (key === ${JSON.stringify(navigationKey)} && failCacheReset) { failCacheReset = false; throw new Error('partial cache reset'); }
      originalCacheWrite(key, value);
    };
  `);
  page.click(page.button('confirm-action'));
  assert.equal(page.node('confirmation-sheet').open, true);
  assertNoClobber(page, fixture, raw);
  assert.deepEqual(page.session(), session);
  assert.equal(page.writes(), 0);
  page.confirm(false);
  const restored = reload(page);
  restored.go('home'); restored.click(restored.node('screen-next'));
  assertReader(restored, 'beef', 3, 21);
});

check('导入家庭落盘失败撤销新建辅助缓存 key，不把原本缺失的草稿改成已重置状态', async () => {
  const fixture = cookingFixture(), page = loadPage(fixture, { household: true });
  await page.import(fixture);
  const session = page.session(), raw = page.householdRaw(), restore = blockStorageWrites(page);
  for (const key of [readingKey, progressKey, builderKey, draftsKey]) assert.equal(session[key], undefined);
  page.click(page.button('confirm-action'));
  assert.equal(page.node('confirmation-sheet').open, true);
  assertNoClobber(page, fixture, raw);
  assert.deepEqual(page.session(), session);
  restore(); page.confirm();
  assert.deepEqual(page.household(), fixture);
  assert.equal(page.writes(), 1);
});

async function run() {
  const files = ['weekend-menu-prototype.html', 'weekend-menu-c.css', 'weekend-menu-phone.cjs', 'weekend-household-model.js', 'weekend-menu-prototype-check.cjs', 'weekend-menu-app-check.cjs'];
  const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(join(__dirname, file))).digest('hex')]));
  const before = hashes();
  console.log('EXECUTION Node VM + existing DOM stubs; synthetic reader geometry; no visual proof, browser, localhost, or real user storage');
  let failures = 0;
  for (const { name, action } of checks) {
    let timeout;
    try {
      await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('单项检查超过10秒')), 10000); })]);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${String(error.stack).slice(0, 2400)}`);
    } finally { clearTimeout(timeout); }
  }
  const after = hashes();
  console.log(`INPUT_SHA256 ${JSON.stringify(before)}`);
  const stable = JSON.stringify(before) === JSON.stringify(after);
  if (!stable) {
    console.error('FAIL 检查期间输入文件发生变化，请在主进程完成修改后重跑。');
  }
  console.log(`INPUT_STABLE ${stable}`);
  console.log(`RESULT ${checks.length - failures} PASS / ${failures} FAIL / ${checks.length} checks`);
  console.log('UNVERIFIED 浏览器渲染、底部遮挡、真机触控及辅助技术；DOM 桩只验证结构与行为。');
  if (failures || !stable) process.exitCode = 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
