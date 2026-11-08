'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const core = require('../core/store');
const {seedRecipes} = require('../core/content');
const {H, M, KEY, META_KEY} = core;
const plain = value => JSON.parse(JSON.stringify(value));
const event = (dataset = {}, value) => ({currentTarget: {dataset}, detail: {value}});

function recipesOnly() {
  const migrated = H.migrate(M.createState(), seedRecipes);
  return {...migrated, activeMealId: null, meals: [], menus: []};
}

function customizedMeal(status = 'planned') {
  let household = H.createMeal(recipesOnly(), {title: '测试晚餐', date: '2026-11-02', recipeIds: ['beef', 'rice']});
  let data = plain(household.meals[0].data);
  data.items[0].quantity = '测试：仅供这餐的用量';
  data.items[0].note = '测试：本餐定制备注';
  data.items[0].status = 'bought';
  data.items[1].choice = 'omit';
  data.items[2].status = 'at-home';
  data = M.addItem(data, '测试自加材料', '测试加菜');
  data.notes = '测试：本餐专属笔记';
  data.reviewed = true;
  data = M.saveVersion(data, '测试版本');
  household = H.updateMealData(household, data);
  return H.setMealStatus(household, household.activeMealId, status);
}

function harness(initial = recipesOnly(), disk = new Map()) {
  if (!disk.has(KEY)) disk.set(KEY, JSON.stringify({storageVersion: 1, epoch: 'builder-pages-test', household: initial}));
  const failures = {business: false, metadata: false, clear: false, navigation: false};
  const calls = {routes: [], toasts: [], modals: [], commits: 0};
  const store = core.createStore({
    getStorageSync: key => disk.get(key),
    setStorageSync(key, value) {
      if (key === KEY && failures.business) throw new Error('测试主数据写入失败');
      if (key === META_KEY && (failures.metadata || failures.clear && !Object.keys(JSON.parse(value).drafts).length)) {
        throw new Error('测试草稿写入失败');
      }
      disk.set(key, value);
      if (key === KEY) calls.commits += 1;
    }
  });
  const navigate = type => options => {
    calls.routes.push({type, url: options.url, delta: options.delta});
    if (failures.navigation) options.fail?.({errMsg: '测试导航失败'});
    else options.success?.({});
  };
  const wx = {
    navigateTo: navigate('navigateTo'), redirectTo: navigate('redirectTo'),
    navigateBack: navigate('navigateBack'), switchTab: navigate('switchTab'),
    showToast: options => calls.toasts.push(options.title), showModal: options => calls.modals.push(options)
  };
  const uiContext = vm.createContext({module: {exports: {}}, wx, getCurrentPages: () => [{}, {}]});
  vm.runInContext(readFileSync(join(__dirname, '../core/ui.js'), 'utf8'), uiContext);
  const ui = uiContext.module.exports;
  function load(name, options = {}) {
    let definition;
    const filename = join(__dirname, `../pages/${name}/index.js`);
    vm.runInNewContext(readFileSync(filename, 'utf8'), {
      wx, Page: value => { definition = value; },
      require(path) {
        if (path === '../../core/store') return {...core, store};
        if (path === '../../core/ui') return ui;
        throw new Error(`Unexpected import: ${path}`);
      }
    }, {filename});
    const page = {...definition, data: plain(definition.data), setData(patch) { Object.assign(this.data, plain(patch)); }};
    page.onLoad?.(options);
    page.onShow?.();
    return page;
  }
  return {store, failures, calls, disk, load};
}

const input = (page, field, value) => page.onInput(event({field}, value));
const select = (page, ids) => page.onRecipesChange(event({}, ids));
const resetData = data => ({...plain(data), items: data.items.map(item => ({...plain(item), status: 'unchecked'})), versions: []});

test('名称/材料搜索保留隐藏选择，添加链接返回刷新菜谱，草稿与键盘状态保留', () => {
  const h = harness(), page = h.load('builder');
  select(page, ['rice']);
  input(page, 'query', '红酒');
  assert.deepEqual(page.data.recipes.map(recipe => recipe.id), ['beef']);
  select(page, ['beef']);
  assert.deepEqual(page.data.recipeIds, ['rice', 'beef']);
  select(page, []);
  assert.deepEqual(page.data.recipeIds, ['rice']);
  input(page, 'query', '米饭');
  assert.deepEqual(page.data.recipes.map(recipe => recipe.id), ['rice']);
  input(page, 'title', '输入中的晚餐');
  page.onFocus();
  assert.equal(page.data.inputFocused, true);
  page.onKeyboardHeightChange({detail: {height: 280}});
  page.onBlur();
  assert.equal(page.data.keyboardOpen, true);
  page.onKeyboardHeightChange({detail: {height: 0}});
  assert.equal(page.data.keyboardOpen, false);
  page.addRecipe();
  assert.equal(h.calls.routes.at(-1).url, '/pages/recipe-edit/index?from=builder');
  page.onHide();
  h.store.change(household => H.saveRecipe(household, {name: '测试链接菜谱', sourceUrl: 'https://example.com/recipe'}));
  page.onShow();
  assert.deepEqual(page.data.recipeIds, ['rice']);
  assert.equal(page.data.title, '输入中的晚餐');
  assert.equal(page.data.recipeCount, 4);
  const reopened = h.load('builder');
  assert.equal(reopened.data.title, page.data.title);
  assert.deepEqual(reopened.data.recipeIds, ['rice']);
  input(reopened, 'query', '测试链接');
  assert.equal(reopened.data.recipes[0].ingredients, '材料尚未记录');
});

test('空餐名/日期可直接开始准备，成功只 redirectTo 购物页且连续点击不重复新增', () => {
  const h = harness(), page = h.load('builder');
  select(page, ['beef']);
  page.save();
  page.save();
  const saved = h.store.meal();
  assert.equal(saved.title, '今晚这餐');
  assert.equal(saved.date, '');
  assert.equal(h.store.get().meals.length, 1);
  assert.equal(h.calls.commits, 1);
  assert.equal(h.calls.routes.length, 1);
  assert.deepEqual(h.calls.routes[0], {type: 'redirectTo', url: `/pages/shopping/index?id=${saved.id}`, delta: undefined});
  assert.equal(h.store.draft('builder:meal:new'), null);
  assert.ok(saved.data.items.every(item => item.quantity === ''));
});

test('选定菜单且菜集合未变时保留定制数据，修改集合后重新合成', () => {
  let initial = customizedMeal();
  initial = H.saveMealAsMenu(initial, '测试定制菜单', 'meal-1');
  const menu = initial.menus[0], h = harness(initial), page = h.load('builder');
  page.chooseMenu(event({id: menu.id}));
  select(page, [...menu.recipeIds].reverse());
  input(page, 'title', '新的餐名');
  page.onDateChange(event({}, '2026-12-01'));
  page.save();
  assert.deepEqual(h.store.meal().data, menu.data);
  assert.equal(h.store.meal().title, '新的餐名');
  assert.equal(h.store.meal().date, '2026-12-01');
  const changed = h.load('builder');
  changed.chooseMenu(event({id: menu.id}));
  select(changed, ['rice']);
  changed.save();
  assert.deepEqual(h.store.meal().recipeIds, ['rice']);
  assert.equal(h.store.meal().data.notes, '');
  assert.ok(h.store.meal().data.items.every(item => item.quantity === ''));
});

test('餐与菜单的新建/编辑草稿按 mode/id 隔离，编辑餐保留定制与数量并回来源', () => {
  let initial = customizedMeal();
  initial = H.saveMealAsMenu(initial, '原菜单', 'meal-1');
  const original = initial.meals[0], h = harness(initial);
  input(h.load('builder'), 'title', '新餐草稿');
  input(h.load('builder', {mode: 'menu'}), 'title', '新菜单草稿');
  const editMenu = h.load('builder', {mode: 'menu', menuId: 'menu-1'});
  input(editMenu, 'title', '菜单编辑草稿');
  const editMeal = h.load('builder', {id: 'meal-1', from: 'history'});
  assert.equal(editMeal.data.title, original.title);
  input(editMeal, 'title', '餐编辑草稿');
  assert.equal(h.load('builder').data.title, '新餐草稿');
  assert.equal(h.load('builder', {mode: 'menu'}).data.title, '新菜单草稿');
  assert.equal(h.load('builder', {mode: 'menu', menuId: 'menu-1'}).data.title, '菜单编辑草稿');
  assert.equal(h.load('builder', {id: 'meal-1'}).data.title, '餐编辑草稿');
  editMeal.save();
  assert.equal(h.store.get().meals.length, 1);
  assert.deepEqual(h.store.meal('meal-1').data, original.data);
  assert.equal(h.store.meal('meal-1').title, '餐编辑草稿');
  assert.equal(h.store.draft('builder:meal:meal-1'), null);
  assert.equal(h.calls.routes.at(-1).type, 'navigateBack');
});

test('菜单新建/编辑不要求日期，保存同集合保留定制、不新建餐', () => {
  let initial = H.saveMealAsMenu(customizedMeal(), '原菜单', 'meal-1');
  const h = harness(initial), originalData = initial.menus[0].data;
  const edit = h.load('builder', {mode: 'menu', menuId: 'menu-1'});
  input(edit, 'title', '改名菜单');
  edit.setData({date: 'invalid-date'});
  edit.save();
  assert.deepEqual(h.store.get().menus[0].data, originalData);
  assert.equal(h.store.get().menus[0].title, '改名菜单');
  const create = h.load('builder', {mode: 'menu'});
  select(create, ['rice']);
  create.save();
  assert.match(create.data.error, /菜单名称/);
  input(create, 'title', '另一份菜单');
  create.save();
  create.save();
  assert.equal(h.store.get().menus.length, 2);
  assert.equal(h.store.get().meals.length, 1);
  assert.equal(h.store.draft('builder:menu:new'), null);
  assert.equal(h.calls.routes.at(-1).type, 'navigateBack');
});

test('主保存失败保留表单和选择；草稿失败保留内存且提交前写入失败不新增餐', () => {
  const h = harness(), page = h.load('builder');
  select(page, ['rice']);
  input(page, 'title', '保留这餐');
  h.failures.business = true;
  page.save();
  assert.equal(h.store.get().meals.length, 0);
  assert.equal(page.data.title, '保留这餐');
  assert.deepEqual(page.data.recipeIds, ['rice']);
  assert.equal(page.data.saving, false);
  assert.match(page.data.error, /保存/);
  assert.equal(h.calls.routes.length, 0);
  h.failures.business = false;
  h.failures.metadata = true;
  input(page, 'title', '内存中的新餐名');
  assert.equal(page.data.title, '内存中的新餐名');
  assert.equal(h.store.draft('builder:meal:new').title, '内存中的新餐名');
  page.save();
  assert.equal(h.store.get().meals.length, 0);
  h.failures.metadata = false;
  page.save();
  assert.equal(h.store.get().meals.length, 1);
  assert.equal(h.store.meal().title, '内存中的新餐名');
});

test('跨重启幂等：主数据已提交但清草稿持久化失败，旧草稿恢复后沿用原餐', () => {
  const h = harness(), page = h.load('builder');
  select(page, ['beef']);
  input(page, 'title', '可以重名的餐');
  h.failures.clear = true;
  page.save();
  page.save();
  const saved = h.store.meal();
  assert.equal(h.store.get().meals.length, 1);
  assert.equal(h.calls.routes.at(-1).url, `/pages/shopping/index?id=${saved.id}`);
  const staleDraft = JSON.parse(h.disk.get(META_KEY)).drafts['builder:meal:new'];
  assert.deepEqual(staleDraft.pending, saved);
  const reboot = harness(undefined, h.disk), reopened = reboot.load('builder');
  assert.equal(reopened.data.committed, true);
  reopened.save();
  assert.equal(reboot.store.get().meals.length, 1);
  assert.deepEqual(reboot.store.meal(saved.id), saved);
  assert.equal(reboot.calls.commits, 0);
  assert.equal(reboot.calls.routes.at(-1).url, `/pages/shopping/index?id=${saved.id}`);
  assert.equal(reboot.store.draft('builder:meal:new'), null);
});

test('清草稿失败后采购、备注和餐状态已有进展，跨重启仍沿用原餐且不回滚进展', () => {
  for (const status of ['planned', 'completed', 'cancelled']) {
    const h = harness(), page = h.load('builder');
    select(page, ['beef', 'rice']);
    input(page, 'title', '继续准备的餐');
    page.onDateChange(event({}, '2026-11-02'));
    h.failures.clear = true;
    page.save();
    const saved = h.store.meal();
    const epoch = JSON.parse(h.disk.get(KEY)).epoch;
    h.store.change(household => H.updateMealData(household,
      M.setNotes(M.updateItem(saved.data, 'beef', {status: 'bought'}), '购物后补充的备注')));
    h.store.change(household => H.updateMeal(household, saved.id, {recipeIds: [...saved.recipeIds].reverse()}));
    h.store.change(household => H.setMealStatus(household, saved.id, status));
    const progressed = h.store.meal(saved.id);
    const metadata = JSON.parse(h.disk.get(META_KEY));
    assert.equal(JSON.parse(h.disk.get(KEY)).epoch, epoch);
    assert.equal(metadata.epoch, epoch);
    assert.notDeepEqual(progressed, metadata.drafts['builder:meal:new'].pending);
    const reboot = harness(undefined, h.disk), reopened = reboot.load('builder');
    assert.equal(reopened.data.committed, true, status);
    reopened.save();
    assert.equal(reboot.store.get().meals.length, 1);
    assert.deepEqual(reboot.store.meal(saved.id), progressed);
    assert.equal(reboot.calls.commits, 0);
    assert.equal(reboot.calls.routes.at(-1).url, `/pages/shopping/index?id=${saved.id}`);
    assert.equal(reboot.store.draft('builder:meal:new'), null);
  }
});

test('清草稿成功后再次安排同名同日期同菜品的新餐，仍可独立创建', () => {
  const h = harness(), page = h.load('builder');
  select(page, ['rice']);
  input(page, 'title', '相同的餐名');
  page.onDateChange(event({}, '2026-11-02'));
  page.save();
  const first = h.store.meal();
  assert.equal(JSON.parse(h.disk.get(META_KEY)).drafts['builder:meal:new'], undefined);
  const reboot = harness(undefined, h.disk), next = reboot.load('builder');
  assert.equal(next.data.committed, false);
  select(next, first.recipeIds);
  input(next, 'title', first.title);
  next.onDateChange(event({}, first.date));
  next.save();
  assert.equal(reboot.store.get().meals.length, 2);
  assert.notEqual(reboot.store.meal().id, first.id);
  assert.deepEqual(reboot.store.meal(first.id), first);
  assert.equal(reboot.calls.commits, 1);
});

test('提交中断后 ID 被不同餐名、日期、菜品或客人的记录占用，不误认并分配新 ID', () => {
  const initial = H.saveGuest(recipesOnly(), {name: '测试客人', avoid: '', note: ''});
  for (const patch of [{title: '另一餐'}, {date: '2026-11-03'}, {recipeIds: ['beef']}, {guestIds: [initial.guests[0].id]}]) {
    const h = harness(initial), page = h.load('builder');
    select(page, ['rice']);
    input(page, 'title', '保留的餐');
    h.failures.business = true;
    page.save();
    assert.ok(JSON.parse(h.disk.get(META_KEY)).drafts['builder:meal:new'].pending);
    const occupied = H.createMeal(initial, {title: '保留的餐', date: '', recipeIds: ['rice'], guestIds: [], ...patch});
    h.failures.business = false;
    h.store.commit(occupied);
    const reboot = harness(undefined, h.disk), reopened = reboot.load('builder');
    assert.equal(reopened.data.committed, false, JSON.stringify(patch));
    reopened.save();
    assert.equal(reboot.store.get().meals.length, 2);
    assert.deepEqual(reboot.store.meal('meal-1'), occupied.meals[0]);
    assert.equal(reboot.store.meal('meal-2').title, '保留的餐');
  }
});

test('主保存成功但跳转失败，重试仅跳转；菜单清草稿失败仍返回并可跨重启沿用', () => {
  const h = harness(), page = h.load('builder');
  select(page, ['rice']);
  h.failures.navigation = true;
  page.save();
  assert.equal(page.data.committed, true);
  assert.match(page.data.error, /已保存/);
  h.failures.navigation = false;
  page.save();
  assert.equal(h.store.get().meals.length, 1);
  const menu = h.load('builder', {mode: 'menu'});
  select(menu, ['rice']);
  input(menu, 'title', '测试菜单');
  h.failures.clear = true;
  menu.save();
  assert.equal(h.calls.routes.at(-1).type, 'navigateBack');
  const reboot = harness(undefined, h.disk), reopened = reboot.load('builder', {mode: 'menu'});
  assert.equal(reopened.data.committed, true);
  reopened.save();
  assert.equal(reboot.store.get().menus.length, 1);
  assert.equal(reboot.calls.commits, 0);
});

test('历史三组展示、购物/做饭继续到指定餐；仅确认后取消，恢复不改变本餐数据', async () => {
  const initial = customizedMeal(), h = harness(initial), page = h.load('history');
  assert.deepEqual(page.data.counts, {planned: 1, completed: 0, cancelled: 0});
  await page.continueMeal(event({id: 'meal-1', page: 'shopping'}));
  assert.equal(h.calls.routes.at(-1).url, '/pages/shopping/index?id=meal-1');
  page.onShow();
  await page.continueMeal(event({id: 'meal-1', page: 'cook'}));
  assert.equal(h.calls.routes.at(-1).url, '/pages/cook/index?id=meal-1');
  page.onShow();
  let cancelling = page.cancelMeal(event({id: 'meal-1'}));
  assert.equal(h.store.meal('meal-1').status, 'planned');
  await page.cancelMeal(event({id: 'meal-1'}));
  assert.equal(h.calls.modals.length, 1);
  h.calls.modals.at(-1).success({confirm: false});
  await cancelling;
  assert.equal(h.store.meal('meal-1').status, 'planned');
  cancelling = page.cancelMeal(event({id: 'meal-1'}));
  h.calls.modals.at(-1).success({confirm: true});
  await cancelling;
  assert.equal(h.store.meal('meal-1').status, 'cancelled');
  assert.equal(h.store.get().meals.length, 1);
  page.changeStatus(event({status: 'cancelled'}));
  assert.equal(page.data.meals[0].id, 'meal-1');
  await page.restoreMeal(event({id: 'meal-1'}));
  assert.equal(page.data.status, 'planned');
  assert.deepEqual(h.store.meal('meal-1').data, initial.meals[0].data);
  h.store.change(household => H.setMealStatus(household, 'meal-1', 'completed'));
  page.changeStatus(event({status: 'completed'}));
  assert.equal(page.data.meals[0].id, 'meal-1');
});

test('历史复做复制原 meal.data，清采购/版本而保留定制；菜谱已改也不影响', async () => {
  const initial = customizedMeal('completed'), original = plain(initial.meals[0]);
  initial.recipes[0].items = [];
  assert.equal(H.validate(initial), true);
  const h = harness(initial), page = h.load('history', {status: 'completed'});
  const first = page.repeatMeal(event({id: original.id}));
  const second = page.repeatMeal(event({id: original.id}));
  await Promise.all([first, second]);
  const repeated = h.store.meal();
  assert.notEqual(repeated.id, original.id);
  assert.deepEqual(repeated.data, resetData(original.data));
  assert.deepEqual(repeated.recipeIds, original.recipeIds);
  assert.deepEqual(repeated.guestIds, original.guestIds);
  assert.equal(repeated.date, '');
  assert.equal(repeated.status, 'planned');
  assert.deepEqual(h.store.meal(original.id), original);
  assert.equal(h.store.get().meals.length, 2);
  assert.equal(h.calls.routes.at(-1).url, `/pages/shopping/index?id=${repeated.id}`);
  h.store.change(household => H.updateMealData(household, M.setNotes(repeated.data, '只改新餐')));
  assert.equal(h.store.meal(original.id).data.notes, original.data.notes);
});

test('历史复做提交失败不新增，导航失败再次点击不重复新增', async () => {
  const h = harness(customizedMeal('cancelled')), page = h.load('history', {status: 'cancelled'});
  h.failures.business = true;
  await page.repeatMeal(event({id: 'meal-1'}));
  assert.equal(h.store.get().meals.length, 1);
  assert.equal(page.data.saving, false);
  h.failures.business = false;
  h.failures.navigation = true;
  await page.repeatMeal(event({id: 'meal-1'}));
  assert.equal(h.store.get().meals.length, 2);
  h.failures.navigation = false;
  await page.repeatMeal(event({id: 'meal-1'}));
  assert.equal(h.store.get().meals.length, 2);
});

test('历史存菜单使用 editable modal，取消不写入、失败保留名称，成功保留本餐定制', async () => {
  const initial = customizedMeal('completed'), h = harness(initial), page = h.load('history');
  let save = page.saveAsMenu(event({id: 'meal-1'}));
  assert.equal(h.calls.modals.at(-1).editable, true);
  h.calls.modals.at(-1).success({confirm: false});
  await save;
  assert.equal(h.store.get().menus.length, 0);
  h.failures.business = true;
  save = page.saveAsMenu(event({id: 'meal-1'}));
  h.calls.modals.at(-1).success({confirm: true, content: '我输入的菜单名'});
  await save;
  assert.equal(h.store.get().menus.length, 0);
  h.failures.business = false;
  save = page.saveAsMenu(event({id: 'meal-1'}));
  assert.equal(h.calls.modals.at(-1).content, '我输入的菜单名');
  h.calls.modals.at(-1).success({confirm: true, content: '我输入的菜单名'});
  await save;
  assert.equal(h.store.get().menus[0].title, '我输入的菜单名');
  assert.deepEqual(h.store.get().menus[0].data, resetData(initial.meals[0].data));
});

test('丢失的餐/菜单不会被误当作新建；表单与历史绑定的 handler 均存在', async () => {
  const h = harness();
  const missing = h.load('builder', {id: 'meal-404'});
  select(missing, ['rice']);
  missing.save();
  assert.match(missing.data.error, /没有找到/);
  assert.equal(h.store.get().meals.length, 0);
  const history = h.load('history');
  await history.restoreMeal(event({id: 'meal-404'}));
  assert.match(history.data.error, /没有找到/);
  for (const name of ['builder', 'history']) {
    const page = h.load(name), wxml = readFileSync(join(__dirname, `../pages/${name}/index.wxml`), 'utf8');
    const config = JSON.parse(readFileSync(join(__dirname, `../pages/${name}/index.json`), 'utf8'));
    for (const match of wxml.matchAll(/\bbind(?:tap|input|change|focus|blur|keyboardheightchange)="([^"]+)"/g)) {
      assert.equal(typeof page[match[1]], 'function', `${name}.${match[1]}`);
    }
    if (name === 'history') assert.ok(config.usingComponents['app-tabs']);
    else {
      assert.match(wxml, /keyboard-action/);
      assert.match(wxml, /wx:if="{{mode === 'meal'}}"/);
    }
  }
});
