const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {setup,memory}=require('./harness.cjs');
const {createStore,H,M,KEY,META_KEY}=require('../core/store');
const {seedRecipes,beefSteps}=require('../core/content');
test('new install is empty; explicit sample preserves user recipe and omissions',()=>{
 const {store}=setup();assert.equal(store.get().recipes.length,0);store.addExamples();assert.equal(store.get().meals.length,0);assert.equal(store.get().recipes.length,3);store.addExamples();assert.equal(store.get().recipes.length,3);
 const beef=store.get().recipes.find(r=>r.id==='beef');assert.equal(beef.steps.length,10);assert.equal(beef.items.find(i=>i.id==='celery').choice,'include');assert.equal(beef.items.find(i=>i.id==='bacon').quantity,'');assert.equal(store.get().recipes.find(r=>r.id==='broccoli').steps.length,0);
 const html=fs.readFileSync(require('node:path').resolve(__dirname,'../../h5/weekend-menu-prototype.html'),'utf8');
 assert.deepEqual(beefSteps,JSON.parse(html.match(/const beefSteps=(\[[^\n]+\]);/)[1]));
});
test('v1 and v2 backups round-trip without inventing quantities, statuses, menus or guests',()=>{
 const {store}=setup();let old=M.updateItem(M.createState(),'bacon',{quantity:'原记录'});old=M.updateItem(old,'bacon',{status:'at-home'});old=M.saveVersion(old,'自己的版本');store.importText(JSON.stringify(old));
 assert.deepEqual(store.meal().data,old);const backup=store.exportText();const {store:other}=setup();other.importText(backup);assert.deepEqual(other.get(),store.get());assert.equal(H.validate(JSON.parse(backup)),true);
});
test('shopping one main action needs neither reviewed nor resolved quantities',()=>{
 const {store}=setup();store.addExamples();store.change(h=>H.createMeal(h,{title:'周末晚餐',recipeIds:['beef','broccoli','rice']}));
 const id=store.meal().id;assert.equal(store.meal().data.reviewed,false);store.startCooking(id);assert.equal(store.meta().cooking[id].recipeId,'beef');assert.equal(store.meal().status,'planned');
});
test('meal/recipe positions persist independently across process reload; reading never completes meal',()=>{
 const {store,api}=setup();store.addExamples();store.change(h=>H.createMeal(h,{title:'A餐',recipeIds:['beef','broccoli']}));const a=store.meal().id;
 store.setReading(a,'beef',900);store.setReading(a,'broccoli',300);store.change(h=>H.createMeal(h,{title:'B餐',recipeIds:['beef']}));const b=store.meal().id;store.setReading(b,'beef',80);
 const restored=createStore(api);assert.deepEqual(restored.meta().cooking[a],{recipeId:'broccoli',positions:{beef:900,broccoli:300}});assert.equal(restored.meta().cooking[b].positions.beef,80);assert.equal(restored.meal(a).status,'planned');
});
test('write failure retains last committed data and draft; retry creates only one record',()=>{
 const {store,api}=setup();store.addExamples();store.saveDraft('builder-new',{title:'晚餐',recipeIds:['beef']});api.failWrite=true;
 assert.throws(()=>store.change(h=>H.createMeal(h,{title:'晚餐',recipeIds:['beef']})),/保存/);assert.equal(store.get().meals.length,0);assert.equal(store.draft('builder-new').title,'晚餐');
 api.failWrite=false;store.change(h=>H.createMeal(h,{title:'晚餐',recipeIds:['beef']}));assert.equal(createStore(api).get().meals.length,1);
});
test('readback failure never claims success; same candidate retry has no duplicate',()=>{
 const api=memory(),store=createStore(api);store.addExamples();const next=H.createMeal(store.get(),{title:'晚餐',recipeIds:['beef']});api.failRead=true;
 assert.throws(()=>store.commit(next),/保存/);assert.equal(store.get().meals.length,0);api.failRead=false;store.commit(next);assert.equal(createStore(api).get().meals.length,1);
});
test('corrupt primary storage is not silently replaced by empty data',()=>{
 const api=memory();api.data.set(KEY,'{broken');const store=createStore(api);assert.match(store.issue(),/原数据已保留/);assert.throws(()=>store.addExamples());assert.equal(api.data.get(KEY),'{broken');
 store.importText(JSON.stringify(H.migrate(M.createState(),seedRecipes)));assert.equal(api.data.get(KEY+'-before-import'),'{broken');assert.equal(store.meal().title,'周末晚餐');
});
test('invalid import is non-destructive and valid import resets unrelated progress',()=>{
 const {store,api}=setup();store.addExamples();store.change(h=>H.createMeal(h,{title:'晚餐',recipeIds:['beef']}));store.startCooking(store.meal().id);const before=store.exportText();
 assert.throws(()=>store.importText('{"schemaVersion":2}'));assert.equal(store.exportText(),before);store.importText(before);assert.deepEqual(store.meta(),{drafts:{},cooking:{}});assert.ok(api.data.get(KEY+'-before-import'));
});
test('editing quantities resets only that ingredient and other meals remain isolated',()=>{
 const {store}=setup();store.addExamples();store.change(h=>H.createMeal(h,{title:'A',recipeIds:['beef']}));const a=store.meal().id;store.change(h=>H.updateMealData(h,M.updateItem(store.meal().data,'bacon',{status:'bought'})));
 store.change(h=>H.createMeal(h,{title:'B',recipeIds:['beef']}));const b=store.meal().id;assert.equal(store.meal(b).data.items.find(i=>i.id==='bacon').status,'unchecked');assert.equal(store.meal(a).data.items.find(i=>i.id==='bacon').status,'bought');
});
test('WeChat fallback normalizes links and rejects credential, scheme, host and port tricks',()=>{
 const context=vm.createContext({module:{exports:{}}});vm.runInContext(fs.readFileSync(require.resolve('../core/source-url'),'utf8'),context);const normalize=context.module.exports.normalize;
 assert.equal(normalize('HTTPS://B23.TV:443/f09s6Nz'),'https://b23.tv/f09s6Nz');assert.equal(normalize('https://example.com'),'https://example.com/');assert.equal(normalize('https://example.com/a/../菜谱'),'https://example.com/%E8%8F%9C%E8%B0%B1');assert.equal(normalize('https://[::1]:8080/a'),'https://[::1]:8080/a');
 for(const link of ['javascript:alert(1)','https://user:pass@example.com/','https://example.com:99999','https://[:::]/','https://-bad.test/','https://999.0.0.1/'])assert.throws(()=>normalize(link));
 assert.throws(()=>H.normalizeSourceUrl('https://example.com\\@attacker.test/'));
});
test('successful import with metadata write failure cannot revive unrelated drafts/positions after restart',()=>{
 const api=memory();let metadataFails=false;const original=api.setStorageSync;api.setStorageSync=(key,value)=>{if(metadataFails&&key===META_KEY)throw new Error('quota');original(key,value);};
 const store=createStore(api);store.addExamples();store.change(h=>H.createMeal(h,{title:'原餐',recipeIds:['beef']}));store.setReading(store.meal().id,'beef',800);store.saveDraft('old-draft',{name:'旧输入'});
 const replacement=H.migrate(M.createState(),seedRecipes);replacement.meals[0].title='另一份导入';metadataFails=true;store.importText(JSON.stringify(replacement));assert.match(store.issue(),/重置失败/);
 metadataFails=false;const reloaded=createStore(api);assert.equal(reloaded.meal().title,'另一份导入');assert.deepEqual(reloaded.meta(),{drafts:{},cooking:{}});
});
test('retry after import write succeeded but readback failed preserves the original recovery copy',()=>{
 const api=memory(),originalRead=api.getStorageSync;let wrongRead=false;api.getStorageSync=key=>{if(wrongRead&&key===KEY){wrongRead=false;return '{}';}return originalRead(key);};
 const originalWrite=api.setStorageSync;let inject=false;api.setStorageSync=(key,value)=>{originalWrite(key,value);if(inject&&key===KEY){wrongRead=true;inject=false;}};
 const store=createStore(api);store.addExamples();const old=store.exportText();const replacement=H.migrate(M.createState(),seedRecipes);replacement.meals[0].title='导入餐';inject=true;
 assert.throws(()=>store.importText(JSON.stringify(replacement)),/保存/);store.importText(JSON.stringify(replacement));
 const copy=JSON.parse(api.data.get(KEY+'-before-import'));assert.deepEqual(copy.household,JSON.parse(old));assert.equal(store.meal().title,'导入餐');
});
test('all locally stored data exports compactly and is accepted by import',()=>{
 const {store}=setup();store.addExamples();const h=store.get();for(let i=0;i<80;i++){
   const one=H.createMeal({...h,meals:[],activeMealId:null},{title:'餐 '+i,recipeIds:['beef','broccoli','rice']}).meals[0];one.id='meal-'+i;one.data.notes='用餐备注'.repeat(300);h.meals.push(one);
 }h.activeMealId=h.meals[0].id;store.commit(h);const backup=store.exportText();assert.ok(Buffer.byteLength(backup)<900*1024);const {store:other}=setup();other.importText(backup);assert.deepEqual(other.get(),h);
});
test('removing the selected dish falls back to the first remaining recipe on start',()=>{
 const {store}=setup();store.addExamples();store.change(h=>H.createMeal(h,{title:'这餐',recipeIds:['beef','rice']}));const id=store.meal().id;store.setReading(id,'beef',800);store.change(h=>H.updateMeal(h,id,{recipeIds:['rice']}));
 assert.equal(store.startCooking(id).recipeId,'rice');assert.equal(store.meta().cooking[id].positions.rice,0);
});
test('a household at the exact payload limit can be exported and restored with a longer import epoch',()=>{
 const {LIMIT}=require('../core/store');const {store}=setup();store.addExamples();const h=store.get(),base=H.createMeal(h,{title:'临界测试',recipeIds:['beef','broccoli','rice']}).meals[0];
 for(let i=0;i<100;i++)h.meals.push({...JSON.parse(JSON.stringify(base)),id:'meal-'+i});h.activeMealId='meal-0';
 let remaining=LIMIT-Buffer.byteLength(JSON.stringify(h));assert.ok(remaining>=0);
 for(const meal of h.meals){const count=Math.min(11997,remaining);meal.data.notes='餐'.repeat(Math.floor(count/3))+'x'.repeat(count%3);remaining-=count;}
 assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(h)),LIMIT);store.commit(h);
 const {store:restored}=setup();restored.importText(store.exportText());assert.deepEqual(restored.get(),h);
});
