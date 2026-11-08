'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, 'weekend-menu-prototype.html'), 'utf8');
const mealScript = html.match(/<script\b[^>]*\bid=["']meal-logic["'][^>]*>([\s\S]*?)<\/script>/i);
assert.ok(mealScript, 'HTML 必须提供 script#meal-logic');
const filename = join(__dirname, 'weekend-household-model.js');
const source = readFileSync(filename, 'utf8');
const context = vm.createContext({ module: { exports: {} }, URL });
vm.runInContext(mealScript[1], context, { filename: 'meal-logic.js', timeout: 1000 });
vm.runInContext(source, context, { filename, timeout: 1000 });
const model = context.HouseholdModel, mealModel = context.MealModel;
const plain = value => JSON.parse(JSON.stringify(value));
const seeds = [
  { id: 'beef', name: '勃艮第炖牛肉', kind: '主菜', steps: [{ title: '炖煮', text: '按自己的配方炖煮。' }] },
  { id: 'broccoli', name: '蒜香西兰花', kind: '配菜', steps: [] },
  { id: 'rice', name: '米饭', kind: '主食', steps: [] }
];
const meal = household => household.meals.find(entry => entry.id === household.activeMealId);
const fresh = () => model.migrate(mealModel.createState(), seeds);
const ingredient = (data, id) => data.items.find(entry => entry.id === id);
let passed = 0, failed = 0;

function check(name, action) {
  try {
    action();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function invoke(method, ...args) {
  const snapshots = args.map(value => JSON.stringify(value));
  args.forEach(freeze);
  let result;
  try {
    result = model[method](...args);
  } finally {
    args.forEach((value, index) => assert.equal(JSON.stringify(value), snapshots[index], `${method} 不可修改输入`));
  }
  assert.equal(model.validate(result), true, `${method} 必须返回有效家庭数据`);
  return result;
}

function rejects(action, pattern = /[\u3400-\u9fff]/) {
  assert.throws(action, error => typeof error.message === 'string' && pattern.test(error.message));
}

check('浏览器全局、CommonJS 导出和完整 API', () => {
  assert.equal(model, context.module.exports);
  const browser = vm.createContext({ URL });
  vm.runInContext(mealScript[1], browser);
  vm.runInContext(source, browser);
  assert.equal(typeof browser.HouseholdModel.migrate, 'function');
  rejects(() => vm.runInNewContext(source), /请先加载 MealModel/);
  const methods = ['validate', 'migrate', 'createMeal', 'selectMeal', 'updateMeal', 'updateMealData', 'setMealStatus',
    'saveRecipe', 'saveMenu', 'saveMealAsMenu', 'useMenu', 'saveGuest', 'removeGuest', 'removeMenu', 'parseIngredients', 'normalizeSourceUrl'];
  assert.deepEqual(Object.keys(model).sort(), methods.sort());
});

check('迁移逐字段保留原材料、备注、购买状态、核对及版本', () => {
  let legacy = mealModel.createState();
  legacy = mealModel.updateItem(legacy, 'beef', { quantity: '800克' });
  legacy = mealModel.updateItem(legacy, 'beef', { status: 'bought' });
  legacy = mealModel.setNotes(legacy, '保留旧备注 <img onerror=alert(1)>');
  legacy = mealModel.saveVersion(legacy, '第一版');
  legacy = mealModel.addItem(legacy, '豆腐', '豆腐汤');
  legacy = mealModel.updateItem(legacy, 'celery', { quantity: '2根', status: 'at-home' });
  legacy = mealModel.saveVersion(legacy, '第二版');
  legacy = mealModel.setReviewed(legacy, true);
  const household = invoke('migrate', legacy, plain(seeds));
  assert.deepEqual(plain(meal(household).data), plain(legacy));
  assert.equal(meal(household).title, '周末晚餐');
  assert.equal(meal(household).status, 'planned');
  assert.equal(household.recipes.find(recipe => recipe.name === '豆腐汤').kind, '自己的菜');
  assert.equal(household.menus.length, 2);
  for (const [index, menu] of household.menus.entries()) {
    const version = legacy.versions[index];
    assert.equal(menu.title, version.name);
    assert.deepEqual(plain(menu.data), { items: plain(version.items).map(item => ({ ...item, status: 'unchecked' })),
      notes: version.notes, reviewed: version.reviewed, versions: [] });
  }
  const defaults = invoke('migrate', null, plain(seeds));
  assert.equal(meal(defaults).data.items.length, mealModel.createState().items.length);
});

check('旧菜名按原格式保留，新录入菜名仍限制60字', () => {
  const legacy = plain(mealModel.createState()), name = '旧菜名'.repeat(30);
  legacy.items.find(item => item.id === 'beef').dish = name;
  assert.equal(mealModel.validate(legacy), true);
  const household = invoke('migrate', legacy, plain(seeds));
  assert.deepEqual(plain(meal(household).data), legacy);
  const recipe = household.recipes.find(entry => entry.name === name);
  assert.ok(recipe);
  const next = invoke('createMeal', household, { title: '复做旧菜', recipeIds: [recipe.id] });
  assert.equal(meal(next).data.items[0].dish, name);
  rejects(() => model.saveRecipe(household, { name, ingredientsText: '米', stepsText: '' }));
});

check('版本独有菜品也迁入菜谱，空种子不漏掉旧材料', () => {
  let legacy = mealModel.createState();
  legacy = mealModel.addItem(legacy, '紫菜', '紫菜汤');
  legacy = mealModel.saveVersion(legacy, '有汤版');
  legacy = { ...plain(legacy), items: legacy.items.filter(item => item.name !== '紫菜') };
  const household = invoke('migrate', legacy, []);
  const soup = household.recipes.find(recipe => recipe.name === '紫菜汤');
  assert.ok(soup);
  assert.ok(household.menus[0].recipeIds.includes(soup.id));
  assert.ok(!meal(household).recipeIds.includes(soup.id));
});

check('迁移不吞掉同菜同名的多行材料，当前用量优先于种子快照', () => {
  const legacy = plain(mealModel.createState());
  ingredient(legacy, 'carrot').quantity = '本餐2根';
  legacy.items.push({ ...plain(ingredient(legacy, 'carrot')), id: 'extra-carrot', quantity: '配菜1根', note: '配菜单列' });
  const recipeSeeds = plain(seeds);
  recipeSeeds[0].items = [{ ...plain(ingredient(legacy, 'carrot')), quantity: '旧种子1根' }];
  let household = invoke('migrate', legacy, recipeSeeds);
  const recipe = household.recipes.find(entry => entry.id === 'beef');
  assert.equal(recipe.items.filter(item => item.name === '胡萝卜').length, 2);
  assert.equal(ingredient(recipe, 'carrot').quantity, '本餐2根');
  assert.deepEqual(plain(meal(household).data), legacy);
  household = invoke('createMeal', household, { title: '复做', recipeIds: ['beef'] });
  const carrot = meal(household).data.items.find(item => item.name === '胡萝卜');
  assert.equal(carrot.quantity, '');
  assert.match(carrot.note, /配菜单列/);
  assert.match(carrot.note, /合计/);
});

check('新餐独立、按所选菜组成、采购重置、西芹取舍保留', () => {
  let household = fresh();
  const originalId = household.activeMealId;
  const data = mealModel.updateItem(meal(household).data, 'celery', { status: 'bought' });
  household = invoke('updateMealData', household, data);
  const oldMeal = plain(meal(household));
  household = invoke('createMeal', household, { title: '下周晚餐', recipeIds: ['beef'], date: '2028-02-29' });
  assert.equal(household.meals.length, 2);
  assert.deepEqual(plain(household.meals.find(entry => entry.id === originalId)), oldMeal);
  assert.ok(meal(household).data.items.every(item => item.dish === '勃艮第炖牛肉' && item.status === 'unchecked'));
  assert.equal(ingredient(meal(household).data, 'celery').choice, 'include');
  household = invoke('selectMeal', household, originalId);
  assert.equal(ingredient(meal(household).data, 'celery').status, 'bought');
});

check('不以固定菜填充无材料新餐，空选择、重复及失效引用拒绝', () => {
  const household = fresh();
  const empty = plain(household);
  empty.recipes.find(recipe => recipe.id === 'rice').items = [];
  assert.equal(model.validate(empty), true);
  const riceOnly = invoke('createMeal', empty, { title: '无材料的菜', recipeIds: ['rice'] });
  assert.deepEqual(plain(meal(riceOnly).data.items), []);
  for (const recipeIds of [[], ['missing'], ['beef', 'beef']]) {
    rejects(() => invoke('createMeal', empty, { title: '测试', recipeIds }));
  }
  const mixed = invoke('createMeal', empty, { title: '含空做法的菜', recipeIds: ['rice', 'broccoli'] });
  assert.ok(meal(mixed).data.items.every(item => item.dish === '蒜香西兰花'));
});

check('完成、取消、恢复与首页继续对象独立于采购门槛', () => {
  let household = fresh();
  const first = household.activeMealId;
  household = invoke('createMeal', household, { title: '第二餐', recipeIds: ['rice'] });
  const second = household.activeMealId;
  household = invoke('setMealStatus', household, second, 'completed');
  assert.equal(household.activeMealId, first);
  rejects(() => invoke('selectMeal', household, second));
  household = invoke('setMealStatus', household, first, 'cancelled');
  assert.equal(household.activeMealId, null);
  rejects(() => invoke('updateMealData', household, mealModel.createState()));
  rejects(() => invoke('setMealStatus', household, first, 'bought'));
  household = invoke('setMealStatus', household, second, 'planned');
  assert.equal(household.activeMealId, second);
  assert.ok(meal(household).data.items.every(item => item.quantity === '' && item.status === 'unchecked'));
  const bought = { ...plain(meal(household).data), items: meal(household).data.items.map(item => ({ ...item, quantity: '1份', status: 'bought' })), reviewed: true };
  household = invoke('updateMealData', household, bought);
  assert.equal(meal(household).status, 'planned');
});

check('updateMeal 同菜及仅顺序变化保留快照、核对与采购', () => {
  let household = fresh();
  const id = household.activeMealId;
  let data = mealModel.updateItem(meal(household).data, 'beef', { quantity: '1千克', status: 'bought' });
  data = mealModel.setNotes(data, '不要丢失这个备注');
  data = mealModel.setReviewed(data, true);
  household = invoke('updateMealData', household, data);
  household = invoke('updateMeal', household, id, { title: '生日餐', date: '2026-10-18', guestIds: [], recipeIds: ['rice', 'broccoli', 'beef'] });
  assert.deepEqual(plain(meal(household).data), plain(data));
  assert.equal(meal(household).title, '生日餐');
  assert.equal(meal(household).date, '2026-10-18');
});

check('updateMeal 换菜清除旧材料并保留 notes 和旧版本', () => {
  let household = fresh();
  let data = mealModel.setNotes(meal(household).data, '仍须保留的备注');
  data = mealModel.saveVersion(data, '旧配方快照');
  data = mealModel.setReviewed(data, true);
  household = invoke('updateMealData', household, data);
  household = invoke('updateMeal', household, household.activeMealId, { recipeIds: ['rice'] });
  assert.deepEqual(Array.from(meal(household).data.items, item => item.name), ['米']);
  assert.equal(meal(household).data.notes, data.notes);
  assert.deepEqual(plain(meal(household).data.versions), plain(data.versions));
  assert.equal(meal(household).data.reviewed, false);
  assert.equal(meal(household).data.items[0].status, 'unchecked');
});

check('菜单自主组菜及编辑、复做互相隔离、不依赖当前餐', () => {
  let household = fresh();
  const initial = plain(meal(household));
  household = invoke('saveMenu', household, { title: '只有米饭', recipeIds: ['rice'] });
  const menuId = household.menus[0].id;
  assert.deepEqual(Array.from(household.menus[0].data.items, item => item.name), ['米']);
  assert.deepEqual(plain(meal(household)), initial);
  household = invoke('saveMenu', household, { id: menuId, title: '素食搭配', recipeIds: ['broccoli', 'rice'] });
  household = invoke('useMenu', household, menuId);
  const firstId = household.activeMealId;
  const data = mealModel.updateItem(meal(household).data, 'rice', { status: 'at-home' });
  household = invoke('updateMealData', household, data);
  const first = plain(meal(household));
  household = invoke('useMenu', household, menuId);
  assert.deepEqual(plain(household.meals.find(entry => entry.id === firstId)), first);
  assert.ok(meal(household).data.items.every(item => item.status === 'unchecked'));
  assert.ok(household.menus[0].data.items.every(item => item.status === 'unchecked'));
  household = invoke('removeMenu', household, menuId);
  assert.equal(household.menus.length, 0);
  assert.equal(household.meals.length, 3);
});

check('保存本餐/已完成/已取消快照，菜单同名必须明确报错', () => {
  let household = fresh();
  const id = household.activeMealId;
  let data = mealModel.updateItem(meal(household).data, 'beef', { quantity: '888克', status: 'bought' });
  data = mealModel.updateItem(data, 'parsley', { choice: 'omit' });
  data = mealModel.setNotes(data, '本餐用量快照');
  household = invoke('updateMealData', household, data);
  household = invoke('saveMealAsMenu', household, '本餐模板');
  const snapshot = plain(household.menus[0].data);
  assert.deepEqual(snapshot, { ...plain(data), items: plain(data.items).map(item => ({ ...item, status: 'unchecked' })), versions: [] });
  rejects(() => invoke('saveMealAsMenu', household, ' 本餐模板 '), /同名/);
  rejects(() => invoke('saveMenu', household, { title: '本餐模板', recipeIds: ['rice'] }), /同名/);
  for (const status of ['completed', 'cancelled']) {
    household = invoke('setMealStatus', household, id, status);
    household = invoke('saveMealAsMenu', household, status, id);
    assert.equal(household.activeMealId, null);
    assert.deepEqual(plain(household.menus.at(-1).data), snapshot);
  }
  household = invoke('useMenu', household, household.menus[0].id);
  assert.deepEqual(plain(meal(household).data), snapshot);
});

check('自定义菜文本解析、空做法待补、保存配方不改已有餐和菜单', () => {
  let household = invoke('saveRecipe', fresh(), { name: '番茄蛋汤', ingredientsText: '番茄｜2个\n鸡蛋|1个\n 水 \n\n', stepsText: '\n  煮水。  \n放入番茄和鸡蛋。\n' });
  const recipe = household.recipes.at(-1);
  assert.match(recipe.id, /^[a-z0-9-]+$/);
  assert.equal(recipe.kind, '自己的菜');
  assert.deepEqual(Array.from(recipe.items, item => [item.name, item.quantity]), [['番茄', '2个'], ['鸡蛋', '1个'], ['水', '']]);
  assert.deepEqual(plain(recipe.steps), [{ title: '步骤 1', text: '  煮水。  ' }, { title: '步骤 2', text: '放入番茄和鸡蛋。' }]);
  household = invoke('createMeal', household, { title: '喝汤', recipeIds: [recipe.id] });
  household = invoke('saveMealAsMenu', household, '汤快照');
  const snapshots = plain([household.meals, household.menus]);
  household = invoke('saveRecipe', household, { id: recipe.id, name: '番茄蛋汤', ingredientsText: '番茄｜3个', stepsText: '' });
  assert.deepEqual(plain([household.meals, household.menus]), snapshots);
  assert.deepEqual(plain(household.recipes.at(-1).steps), []);
  household = invoke('createMeal', household, { title: '新汤', recipeIds: [recipe.id] });
  assert.equal(meal(household).data.items[0].quantity, '3个');
});

check('HTTP/HTTPS 链接标准化、长度边界及空输入约定', () => {
  const examples = [
    ['  HTTPS://Example.COM:443/a/../recipe?q=2&v=1#steps  ', 'https://example.com/recipe?q=2&v=1#steps'],
    ['http://EXAMPLE.com:80', 'http://example.com/'],
    ['https://example.com:8443/Recipe', 'https://example.com:8443/Recipe'],
    ['https://example.com/牛肉', 'https://example.com/%E7%89%9B%E8%82%89'],
    ['https://例子.测试/', 'https://xn--fsqu00a.xn--0zwm56d/'],
    ['https://[::1]/recipe', 'https://[::1]/recipe'],
    ['', ''], ['  ', '']
  ];
  for (const [value, expected] of examples) assert.equal(model.normalizeSourceUrl(value), expected);
  const boundary = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length);
  const household = invoke('saveRecipe', fresh(), { name: '边界链接', sourceUrl: boundary });
  assert.equal(household.recipes.at(-1).sourceUrl.length, 2048);
  rejects(() => model.normalizeSourceUrl(boundary + 'a'));
  rejects(() => model.normalizeSourceUrl('https://example.com/' + '菜'.repeat(300)));
});

check('非法链接在保存和备份校验均拒绝，错误不包含输入或凭据', () => {
  const marker = 'test-private-marker', message = '菜谱链接须为不含账号密码的 HTTP/HTTPS 地址，最多2048字。';
  const invalid = [
    null, undefined, 12, {}, [], 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/recipe',
    'ftp://example.com/recipe', '//example.com/recipe', '/recipe', 'example.com', 'https:', 'https://',
    'https:example.com', 'https:///example.com', 'https://example.com:70000', 'https://[invalid]',
    `https://user:${marker}@example.com/recipe`, `https://${marker}@example.com`, 'https://@example.com',
    'https://example.com\\@other.test', 'https://exa\nmple.com', 'https://example.com/\tpath',
    'https://example.com/\u0000path', 'https://example.com/\u007fpath', 'https://example.com/a b'
  ];
  const household = fresh();
  for (const sourceUrl of invalid) {
    for (const action of [() => model.normalizeSourceUrl(sourceUrl),
      () => model.saveRecipe(household, { name: '非法链接', sourceUrl, ingredientsText: '水', stepsText: '' })]) {
      let caught;
      try { action(); } catch (error) { caught = error; }
      assert.ok(caught?.message === message && !caught.stack.includes(marker), '只返回固定错误，不回显输入');
    }
    const backup = plain(household);
    backup.recipes[0].sourceUrl = sourceUrl;
    assert.equal(model.validate(backup), false);
  }
});

check('schemaVersion 2 兼容无链接备份，菜谱只允许新增 sourceUrl 数据字段', () => {
  const old = plain(fresh());
  assert.equal(old.schemaVersion, 2);
  assert.ok(old.recipes.every(recipe => !Object.hasOwn(recipe, 'sourceUrl')));
  assert.equal(model.validate(old), true);
  const withLink = plain(old);
  withLink.recipes[0].sourceUrl = 'HTTPS://Example.com:443/recipe';
  assert.equal(model.validate(withLink), true);
  assert.deepEqual(plain(model.selectMeal(withLink, withLink.activeMealId)), withLink);
  let getterCalls = 0;
  for (const mutate of [
    recipe => { recipe.sourceUrl = ''; },
    recipe => { recipe.sourceUrl = '   '; },
    recipe => { recipe.extra = true; },
    recipe => { recipe[Symbol('extra')] = true; },
    recipe => { delete recipe.items; },
    recipe => { Object.defineProperty(recipe, 'sourceUrl', { value: 'https://example.com', enumerable: false }); },
    recipe => { Object.defineProperty(recipe, 'sourceUrl', { get() { getterCalls += 1; return 'https://example.com'; }, enumerable: true }); }
  ]) {
    const invalid = plain(withLink);
    mutate(invalid.recipes[0]);
    assert.equal(model.validate(invalid), false);
  }
  assert.equal(getterCalls, 0);
});

check('链接加菜名支持空材料做法，编辑省略链接保留原值且不改变旧快照', () => {
  let household = invoke('saveRecipe', fresh(), { name: ' 链接菜 ', sourceUrl: ' HTTPS://Example.com:443/recipe ', ingredientsText: '', stepsText: '' });
  const recipe = household.recipes.at(-1), snapshots = plain([household.meals, household.menus, household.guests]);
  assert.equal(recipe.name, '链接菜');
  assert.equal(recipe.sourceUrl, 'https://example.com/recipe');
  assert.deepEqual(plain([recipe.items, recipe.steps]), [[], []]);
  household = invoke('saveRecipe', household, { name: '另一链接菜', sourceUrl: 'http://example.com/other' });
  assert.deepEqual(plain([household.recipes.at(-1).items, household.recipes.at(-1).steps]), [[], []]);
  household = invoke('saveRecipe', household, { id: recipe.id, name: '已补材料', ingredientsText: '水｜1碗', stepsText: '煮开。' });
  const updated = household.recipes.find(entry => entry.id === recipe.id);
  assert.equal(updated.sourceUrl, recipe.sourceUrl);
  assert.equal(updated.items[0].quantity, '1碗');
  assert.equal(updated.steps[0].text, '煮开。');
  assert.deepEqual(plain([household.meals, household.menus, household.guests]), snapshots);
  household = invoke('saveRecipe', household, { id: recipe.id, name: updated.name, sourceUrl: '', ingredientsText: '水｜1碗', stepsText: '煮开。' });
  assert.equal(Object.hasOwn(household.recipes.find(entry => entry.id === recipe.id), 'sourceUrl'), false);
  for (const options of [
    { name: '无链接', ingredientsText: '', stepsText: '' },
    { name: '无链接', ingredientsText: '水' },
    { name: '非法材料', sourceUrl: recipe.sourceUrl, ingredientsText: undefined },
    { name: '非法做法', sourceUrl: recipe.sourceUrl, stepsText: undefined },
    { name: '未知字段', sourceUrl: recipe.sourceUrl, unknown: true }
  ]) rejects(() => model.saveRecipe(household, options));
});

check('同一标准链接复用原菜谱，保留名称材料做法且满容量仍可复用', () => {
  let household = plain(fresh());
  household.recipes[0].sourceUrl = 'HTTPS://Example.COM:443/a/../recipe?q=2&v=1#steps';
  const original = plain(household);
  const sourceUrl = 'https://example.com/recipe?q=2&v=1#steps';
  for (const ingredientsText of ['', '水｜1碗']) {
    const reused = invoke('saveRecipe', household, { name: '重复收藏的另一个名字', sourceUrl, ingredientsText, stepsText: '新做法不应覆盖原做法。' });
    assert.deepEqual(plain(reused), original);
    assert.notEqual(reused.recipes[0], household.recipes[0]);
  }
  rejects(() => model.saveRecipe(household, { id: 'rice', name: '米饭', sourceUrl, ingredientsText: '米', stepsText: '' }), /相同链接/);
  household = plain(household);
  while (household.recipes.length < 100) {
    const index = household.recipes.length;
    household.recipes.push({ id: `link-capacity-${index}`, name: `菜${index}`, kind: '自己的菜', items: [], steps: [] });
  }
  assert.deepEqual(plain(invoke('saveRecipe', household, { name: '容量已满的重复收藏', sourceUrl })), household);
  rejects(() => model.saveRecipe(household, { name: '新链接', sourceUrl: 'https://example.com/new' }), /最多/);
});

check('链接菜可安排空购物餐、保存复用菜单及完成取消，备份保留访客和空版本', () => {
  let household = invoke('saveGuest', fresh(), { name: '小林', avoid: '花生', note: '保留访客资料' });
  const original = plain(meal(household)), guestId = household.guests[0].id;
  household = invoke('saveRecipe', household, { name: '链接菜', sourceUrl: 'https://example.com/recipe' });
  const recipeId = household.recipes.at(-1).id;
  household = invoke('createMeal', household, { title: '看链接做饭', recipeIds: [recipeId], guestIds: [guestId] });
  const emptyId = household.activeMealId;
  assert.deepEqual(plain(meal(household).data), { items: [], reviewed: false, notes: '', versions: [] });
  assert.deepEqual(plain(mealModel.summary(meal(household).data)), {
    unresolvedChoices: 0, missingQuantities: 0, unchecked: 0, toBuy: 0, bought: 0, atHome: 0, required: 0, ready: false
  });
  let data = mealModel.setNotes(meal(household).data, '材料以后按链接补充');
  data = mealModel.saveVersion(data, '未补材料');
  household = invoke('updateMealData', household, data);
  household = invoke('saveMenu', household, { title: '链接菜单', recipeIds: [recipeId] });
  household = invoke('saveMealAsMenu', household, '链接快照');
  for (const menu of household.menus) {
    assert.deepEqual(plain(menu.data.items), []);
    household = invoke('useMenu', household, menu.id);
    assert.deepEqual(plain(meal(household).data.items), []);
    assert.equal(meal(household).status, 'planned');
  }
  for (const status of ['completed', 'cancelled', 'planned']) {
    household = invoke('setMealStatus', household, emptyId, status);
    const saved = household.meals.find(entry => entry.id === emptyId);
    assert.equal(saved.status, status);
    assert.deepEqual(plain(saved.data), plain(data));
    assert.deepEqual(plain(saved.guestIds), [guestId]);
  }
  const backup = plain(household);
  assert.equal(model.validate(backup), true);
  assert.deepEqual(backup.guests, [{ id: guestId, name: '小林', avoid: '花生', note: '保留访客资料' }]);
  assert.deepEqual(backup.meals.find(entry => entry.id === original.id), original);
  rejects(() => model.migrate({ ...plain(mealModel.createState()), items: [] }, seeds));
  rejects(() => model.migrate({ ...plain(mealModel.createState()), versions: plain(data.versions) }, seeds));
});

check('换成链接菜清空旧购物项，空数据仍严格限制数组、材料和版本形状', () => {
  let household = invoke('saveRecipe', fresh(), { name: '链接菜', sourceUrl: 'https://example.com/recipe' });
  const recipeId = household.recipes.at(-1).id;
  household = invoke('updateMealData', household, mealModel.saveVersion(meal(household).data, '原材料'));
  const versions = plain(meal(household).data.versions);
  household = invoke('updateMeal', household, household.activeMealId, { recipeIds: [recipeId] });
  assert.deepEqual(plain(meal(household).data.items), []);
  assert.deepEqual(plain(meal(household).data.versions), versions);
  household = invoke('saveMenu', household, { title: '空菜单', recipeIds: [recipeId] });
  const menuId = household.menus[0].id;
  household = invoke('saveMenu', household, { id: menuId, title: '有材料菜单', recipeIds: ['rice'] });
  assert.deepEqual(Array.from(household.menus[0].data.items, item => item.name), ['米']);
  household = invoke('saveMenu', household, { id: menuId, title: '再换回空菜单', recipeIds: [recipeId] });
  assert.deepEqual(plain(household.menus[0].data.items), []);
  for (const mutate of [
    data => { data.items = Array(1); },
    data => { data.items.extra = true; },
    data => { data.items = [{}]; },
    data => { data.items = Array.from({ length: 101 }, (_, index) => ({ ...versions[0].items[0], id: `item-${index}` })); },
    data => { data.items = [{ ...versions[0].items[0], extra: true }]; },
    data => { data.versions = [{ name: '空版本', items: [], reviewed: false, notes: '', extra: true }]; }
  ]) {
    const data = plain(meal(household).data);
    mutate(data);
    rejects(() => model.updateMealData(household, data));
  }
});

check('F07 顿号菜名组餐及换菜保留单菜用量、原餐与版本快照', () => {
  let household = invoke('saveRecipe', fresh(), { name: '土豆、蒜炒丝', ingredientsText: '土豆｜2个\n蒜｜2瓣', stepsText: '' });
  const recipe = household.recipes.at(-1), originalId = household.activeMealId;
  let data = mealModel.setNotes(meal(household).data, '保留原餐备注');
  data = mealModel.saveVersion(data, '换菜前');
  household = invoke('updateMealData', household, data);
  const original = plain(meal(household));
  household = invoke('createMeal', household, { title: '安排顿号菜', recipeIds: [recipe.id] });
  assert.deepEqual(plain(meal(household).data.items), plain(recipe.items));
  assert.equal(mealModel.summary(meal(household).data).missingQuantities, 0);
  assert.deepEqual(plain(household.meals.find(entry => entry.id === originalId)), original);
  household = invoke('updateMeal', household, originalId, { recipeIds: [recipe.id] });
  const updated = household.meals.find(entry => entry.id === originalId);
  assert.deepEqual(plain(updated.data.items), plain(recipe.items));
  assert.equal(updated.data.notes, original.data.notes);
  assert.deepEqual(plain(updated.data.versions), original.data.versions);
  assert.equal(household.schemaVersion, 2);
});

check('F07 顿号菜名餐单创建、换菜和复用保留用量，同菜改名保留定制快照', () => {
  let household = invoke('saveRecipe', fresh(), { name: '土豆、蒜炒丝', ingredientsText: '土豆｜2个\n蒜｜2瓣', stepsText: '' });
  const recipe = household.recipes.at(-1);
  household = invoke('saveMenu', household, { title: '顿号菜餐单', recipeIds: [recipe.id] });
  assert.deepEqual(plain(household.menus.at(-1).data.items), plain(recipe.items));
  household = invoke('saveMenu', household, { title: '换菜餐单', recipeIds: ['rice'] });
  const menuId = household.menus.at(-1).id;
  household = invoke('saveMenu', household, { id: menuId, title: '换菜餐单', recipeIds: [recipe.id] });
  assert.deepEqual(plain(household.menus.at(-1).data.items), plain(recipe.items));
  household = invoke('useMenu', household, menuId);
  assert.deepEqual(plain(meal(household).data.items), plain(recipe.items));
  let data = mealModel.updateItem(meal(household).data, recipe.items[0].id, { quantity: '3个', status: 'bought' });
  data = mealModel.setNotes(data, '本餐定制用量');
  data = mealModel.setReviewed(data, true);
  household = invoke('updateMealData', household, data);
  household = invoke('saveMealAsMenu', household, '定制快照');
  const snapshotMenu = plain(household.menus.at(-1)), snapshots = plain(household.meals);
  assert.deepEqual(snapshotMenu.data, { ...plain(data), items: plain(data.items).map(item => ({ ...item, status: 'unchecked' })), versions: [] });
  household = invoke('saveRecipe', household, { id: recipe.id, name: recipe.name, ingredientsText: '土豆｜4个\n蒜｜4瓣', stepsText: '' });
  household = invoke('saveMenu', household, { id: snapshotMenu.id, title: '定制快照改名', recipeIds: [recipe.id] });
  assert.deepEqual(plain(household.menus.at(-1).data), snapshotMenu.data);
  assert.deepEqual(plain(household.meals), snapshots);
  household = invoke('useMenu', household, snapshotMenu.id);
  assert.deepEqual(plain(meal(household).data), snapshotMenu.data);
});

check('F07 顿号菜名与另一菜真实共享食材时，任意顺序只清空共享用量', () => {
  let household = invoke('saveRecipe', fresh(), { name: '土豆、蒜炒丝', ingredientsText: '土豆｜2个\n蒜｜2瓣', stepsText: '' });
  const stirFryId = household.recipes.at(-1).id;
  household = invoke('saveRecipe', household, { name: '蒜汤', ingredientsText: '蒜｜3瓣\n水｜1碗', stepsText: '' });
  const soupId = household.recipes.at(-1).id;
  for (const recipeIds of [[stirFryId, soupId], [soupId, stirFryId]]) {
    const composed = invoke('createMeal', household, { title: '真实共享', recipeIds });
    const data = meal(composed).data, garlic = data.items.find(item => item.name === '蒜');
    assert.equal(data.items.find(item => item.name === '土豆').quantity, '2个');
    assert.equal(data.items.find(item => item.name === '水').quantity, '1碗');
    assert.equal(garlic.quantity, '');
    assert.match(garlic.note, /共享食材.*核对.*合计/);
    assert.equal(mealModel.summary(data).missingQuantities, 1);
    assert.equal(new Set(data.items.map(item => item.id)).size, data.items.length);
  }
});

check('同名食材合并、数量不拼算、取舍冲突标待核且 ID 不碰撞', () => {
  let household = invoke('saveRecipe', fresh(), { name: '蒜汤', ingredientsText: '蒜｜3瓣\n水｜1碗', stepsText: '' });
  const recipeId = household.recipes.at(-1).id;
  household = invoke('saveRecipe', household, { name: '水煮菜', ingredientsText: '水｜2碗\n青菜｜1把', stepsText: '' });
  const greensId = household.recipes.at(-1).id;
  household = invoke('createMeal', household, { title: '共享材料', recipeIds: ['broccoli', recipeId, greensId] });
  const items = meal(household).data.items;
  assert.equal(items.filter(item => item.name === '蒜').length, 1);
  assert.equal(items.find(item => item.name === '蒜').quantity, '');
  assert.match(items.find(item => item.name === '蒜').note, /核对.*合计/);
  assert.equal(items.find(item => item.name === '水').quantity, '');
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  const conflicting = plain(household);
  conflicting.recipes.find(recipe => recipe.id === recipeId).items[0].choice = 'omit';
  household = invoke('createMeal', conflicting, { title: '取舍不同', recipeIds: ['broccoli', recipeId] });
  assert.equal(meal(household).data.items.find(item => item.name === '蒜').choice, 'pending');
});

check('迁移共享 dish 与种子共享材料保留原餐用量、配方明确缺量', () => {
  const legacy = plain(mealModel.createState());
  const garlic = ingredient(legacy, 'garlic');
  garlic.dish = '蒜香西兰花、勃艮第炖牛肉';
  garlic.quantity = '5瓣';
  garlic.note = '原先是全餐合计';
  const seedWithItems = plain(seeds);
  seedWithItems[1].items = [plain(garlic)];
  const unnormalized = plain(fresh());
  unnormalized.recipes.find(recipe => recipe.id === 'broccoli').items = [plain(garlic)];
  const recomposed = invoke('createMeal', unnormalized, { title: '兼容旧共享字段', recipeIds: ['broccoli'] });
  assert.equal(meal(recomposed).data.items[0].quantity, '');
  assert.match(meal(recomposed).data.items[0].note, /原先是全餐合计/);
  assert.match(meal(recomposed).data.items[0].note, /核对.*合计/);
  let household = invoke('migrate', legacy, seedWithItems);
  assert.deepEqual(plain(meal(household).data), legacy);
  for (const id of ['beef', 'broccoli']) {
    const entry = household.recipes.find(recipe => recipe.id === id).items.find(item => item.name === '蒜');
    assert.equal(entry.quantity, '');
    assert.match(entry.note, /原先是全餐合计/);
    assert.match(entry.note, /核对.*合计/);
  }
  household = invoke('createMeal', household, { title: '只做配菜仍需核对用量', recipeIds: ['broccoli'] });
  assert.equal(meal(household).data.items.find(item => item.name === '蒜').quantity, '');
});

check('客人增改删、餐次引用完整且不按忌口删食材', () => {
  let household = invoke('saveGuest', fresh(), { name: '小林', avoid: '西芹、牛肉', note: '请人工核对' });
  const guestId = household.guests[0].id;
  household = invoke('createMeal', household, { title: '聚餐', recipeIds: ['beef'], guestIds: [guestId] });
  assert.equal(ingredient(meal(household).data, 'celery').choice, 'include');
  household = invoke('saveGuest', household, { id: guestId, name: '林', avoid: '花生', note: '' });
  assert.equal(household.guests.length, 1);
  assert.equal(household.guests[0].avoid, '花生');
  const data = plain(meal(household).data);
  household = invoke('removeGuest', household, guestId);
  assert.deepEqual(plain(meal(household).guestIds), []);
  assert.deepEqual(plain(meal(household).data), data);
  rejects(() => invoke('createMeal', household, { title: '失效客人', recipeIds: ['rice'], guestIds: [guestId] }));
  rejects(() => invoke('removeGuest', household, guestId));
});

check('所有文本按纯文本保留，不解释脚本、标记或对象属性名', () => {
  const payload = '<img src=x onerror=alert(1)>';
  let household = invoke('saveRecipe', fresh(), { name: payload, ingredientsText: '__proto__｜1份\nconstructor\n<script>alert(1)</script>', stepsText: payload });
  const id = household.recipes.at(-1).id;
  household = invoke('createMeal', household, { title: payload, recipeIds: [id] });
  household = invoke('saveGuest', household, { name: payload, avoid: payload, note: payload });
  household = invoke('saveMenu', household, { title: payload, recipeIds: [id] });
  assert.equal(meal(household).title, payload);
  assert.equal(household.recipes.at(-1).steps[0].text, payload);
  assert.equal(meal(household).data.items[0].name, '__proto__');
  assert.equal({}.polluted, undefined);
});

check('损坏 schema、ID、采购、引用、未知属性、循环和 getter 均拒绝', () => {
  const mutations = [
    value => { value.schemaVersion = 1; },
    value => { value.activeMealId = 'missing'; },
    value => { value.meals[0].status = 'completed'; },
    value => { value.recipes[0].id = 'UPPER_case'; },
    value => { value.recipes.push(plain(value.recipes[0])); },
    value => { value.meals[0].guestIds = ['unknown']; },
    value => { value.meals[0].recipeIds = []; },
    value => { value.meals[0].date = '2026-02-29'; },
    value => { value.meals[0].data.items[0].quantity = 3; },
    value => { value.meals[0].data.items[0].status = 'ready'; },
    value => { value.meals[0].data.items[0].choice = 'maybe'; },
    value => { value.meals[0].data.items[0].id = 'bad.id'; },
    value => { value.meals[0].data.items[0].dish = ''; },
    value => { value.meals[0].data.items[0].unexpected = 'field'; },
    value => { value.meals[0].data.items.push(value.meals[0].data.items[0]); },
    value => { value.meals[0].data.items = null; },
    value => { value.meals[0].data.reviewed = 'yes'; },
    value => { value.extra = true; },
    value => { value.recipes[0].steps = [{ title: '步骤', text: '长'.repeat(2001) }]; },
    value => { value.meals[0].data.notes = '长'.repeat(4001); },
    value => { value.meals = { length: 1 }; },
    value => { delete value.meals[0]; },
    value => { value.meals[0].data.versions = [value.meals[0].data]; },
    value => { Object.defineProperty(value.meals[0], 'title', { get() { throw new Error('不得执行'); }, enumerable: true }); },
    value => { value.recipes[0] = Object.assign(Object.create({ polluted: true }), value.recipes[0]); },
    value => { Object.defineProperty(value, '__proto__', { value: { polluted: true }, enumerable: true }); }
  ];
  for (const mutate of mutations) {
    const value = plain(fresh());
    mutate(value);
    assert.equal(model.validate(value), false);
    rejects(() => model.createMeal(value, { title: '测试', recipeIds: ['rice'] }));
  }
  for (const invalid of [null, [], {}, 'text', 2]) assert.equal(model.validate(invalid), false);
  rejects(() => invoke('migrate', { ...plain(mealModel.createState()), items: [] }, plain(seeds)));
});

check('所有输入边界的错误使用中文，未知字段及失效 ID 不静默忽略', () => {
  const household = fresh();
  const invalid = [
    () => model.createMeal(household, { title: '测试', recipeIds: undefined }),
    () => model.createMeal(household, { title: '测试', recipeIds: ['rice'], guestIds: ['missing'] }),
    () => model.createMeal(household, { title: '测试', recipeIds: ['rice'], date: '2026-13-01' }),
    () => model.createMeal(household, { title: '测试', recipeIds: ['rice'], status: 'completed' }),
    () => model.updateMeal(household, household.activeMealId, { title: undefined }),
    () => model.updateMeal(household, household.activeMealId, { guestIds: ['missing'] }),
    () => model.updateMeal(household, household.activeMealId, { data: {} }),
    () => model.updateMealData(household, {}),
    () => model.selectMeal(household, 'missing'),
    () => model.saveGuest(household, { id: 'missing', name: '客人', avoid: '', note: '' }),
    () => model.saveRecipe(household, { id: '../escape', name: '菜', ingredientsText: '水', stepsText: '' }),
    () => model.saveMenu(household, { title: '菜', recipeIds: ['rice'], id: 'missing' }),
    () => model.useMenu(household, 'missing'),
    () => model.removeMenu(household, 'missing'),
    () => model.parseIngredients('水｜1份｜2份', '汤'),
    () => model.parseIngredients('', '汤'),
    () => model.parseIngredients('水', ''),
    () => model.saveGuest(household, JSON.parse('{"name":"人","avoid":"","note":"","__proto__":{}}'))
  ];
  for (const action of invalid) rejects(action);
});

check('材料与做法长度边界、100项材料及空白行规则', () => {
  const household = fresh();
  assert.equal(model.parseIngredients('名'.repeat(60) + '｜' + '量'.repeat(80), '菜')[0].quantity.length, 80);
  assert.equal(model.parseIngredients(Array.from({ length: 100 }, (_, index) => `材料${index}`).join('\n'), '菜').length, 100);
  for (const value of ['名'.repeat(61), '米｜' + '量'.repeat(81), Array(101).fill('米').join('\n'), ' '.repeat(20001)]) {
    rejects(() => model.parseIngredients(value, '菜'));
  }
  const options = { name: '边界菜', ingredientsText: '米', stepsText: Array(9).fill('步'.repeat(2000)).concat('步'.repeat(1991)).join('\n') };
  const valid = invoke('saveRecipe', household, options);
  assert.equal(valid.recipes.at(-1).steps.length, 10);
  rejects(() => model.saveRecipe(household, { ...options, stepsText: '步'.repeat(2001) }));
  rejects(() => model.saveRecipe(household, { ...options, stepsText: '步'.repeat(20001) }));
});

check('餐100、菜100、菜单50、客人50的容量边界及超限拒绝', () => {
  for (const [key, maximum] of Object.entries({ meals: 100, recipes: 100, menus: 50, guests: 50 })) {
    let household = plain(fresh());
    if (key === 'menus') household = plain(model.saveMenu(household, { title: '菜单0', recipeIds: ['rice'] }));
    if (key === 'guests') household = plain(model.saveGuest(household, { name: '客人0', avoid: '', note: '' }));
    while (household[key].length < maximum) {
      const entry = plain(household[key][0]), index = household[key].length;
      entry.id = `capacity-${index}`;
      if (key === 'recipes') entry.name = `菜${index}`;
      if (key === 'menus') entry.title = `菜单${index}`;
      household[key].push(entry);
    }
    assert.equal(model.validate(household), true);
    const over = plain(household), extra = plain(over[key][0]);
    extra.id = 'capacity-over';
    if (key === 'recipes') extra.name = '超限菜';
    if (key === 'menus') extra.title = '超限菜单';
    over[key].push(extra);
    assert.equal(model.validate(over), false);
    const actions = {
      meals: () => model.createMeal(household, { title: '超限', recipeIds: ['rice'] }),
      recipes: () => model.saveRecipe(household, { name: '超限', ingredientsText: '米', stepsText: '' }),
      menus: () => model.saveMenu(household, { title: '超限', recipeIds: ['rice'] }),
      guests: () => model.saveGuest(household, { name: '超限', avoid: '', note: '' })
    };
    rejects(actions[key]);
  }
});

check('返回值嵌套不与输入、其他餐或菜单共享引用', () => {
  const household = fresh(), original = JSON.stringify(household);
  const next = invoke('createMeal', household, { title: '独立餐', recipeIds: ['rice'] });
  next.meals[0].data.items[0].note = '只修改返回值';
  next.recipes[0].steps[0].text = '只修改返回菜谱';
  assert.equal(JSON.stringify(household), original);
  const firstId = next.activeMealId;
  let menus = invoke('saveMealAsMenu', next, '独立模板');
  menus = invoke('useMenu', menus, menus.menus[0].id);
  meal(menus).data.items[0].note = '只修改复做餐';
  assert.notEqual(menus.meals.find(entry => entry.id === firstId).data.items[0].note, '只修改复做餐');
  assert.notEqual(menus.menus[0].data.items[0].note, '只修改复做餐');
});

console.log(`\n${passed} PASS, ${failed} FAIL`);
if (failed) process.exitCode = 1;
