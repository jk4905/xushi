const test=require('node:test'),assert=require('node:assert/strict');
const {setup,page}=require('./harness.cjs');
function meal(){const env=setup();env.store.addExamples();env.store.change(h=>env.H.createMeal(h,{title:'周末晚餐',recipeIds:['beef','broccoli','rice']}));return env;}
test('shopping toggles same keyed row; one action opens full cooking without modal',()=>{
 const {store}=meal(),{instance:p,calls}=page('shopping',store);p.onLoad({id:store.meal().id});p.onShow();const ids=p.data.items.map(i=>i.id);
 p.toggle({currentTarget:{dataset:{index:0}}});assert.equal(p.data.items[0].checked,true);p.toggle({currentTarget:{dataset:{index:0}}});assert.equal(p.data.items[0].checked,false);assert.deepEqual(p.data.items.map(i=>i.id),ids);
 p.start();assert.equal(calls.at(-1)[0],'navigateTo');assert.match(calls.at(-1)[1].url,/\/cook\/index/);assert.equal(calls.filter(c=>c[0]==='modal').length,0);
});
test('failed shopping save keeps checkbox unchanged and retry commits once',()=>{
 const {store,api}=meal(),{instance:p}=page('shopping',store);p.onLoad({id:store.meal().id});p.onShow();api.failWrite=true;p.toggle({currentTarget:{dataset:{index:0}}});assert.equal(p.data.items[0].checked,false);assert.match(p.data.error,/保存/);api.failWrite=false;p.toggle({currentTarget:{dataset:{index:0}}});assert.equal(p.data.items[0].checked,true);
});
test('switch A to B, hide/show, switch back retains each recipe position',()=>{
 const {store}=meal(),{instance:p}=page('cook',store);p.onLoad({id:store.meal().id});p.onShow();p.onScroll({detail:{scrollTop:900}});p.choose({currentTarget:{dataset:{id:'broccoli'}}});p.onScroll({detail:{scrollTop:300}});p.onHide();p.onShow();assert.equal(p.data.scrollTop,300);p.choose({currentTarget:{dataset:{id:'beef'}}});assert.equal(p.data.scrollTop,900);assert.equal(store.meal().status,'planned');
});
test('end of reading and cancelling finish leave meal planned; confirmed completion persists',async()=>{
 const {store}=meal(),id=store.meal().id;const {instance:p}=page('cook',store,{confirm:false});p.onLoad({id});p.onShow();p.onScroll({detail:{scrollTop:9000}});p.onHide();assert.equal(store.meal(id).status,'planned');await p.finish();assert.equal(store.meal(id).status,'planned');const {instance:yes}=page('cook',store);yes.onLoad({id});yes.onShow();await yes.finish();assert.equal(store.meal(id).status,'completed');
});
test('adjustment saves and returns to source; failure retains inputs and remains on page',()=>{
 const {store,api}=meal(),id=store.meal().id,{instance:p,calls}=page('adjust',store);p.onLoad({id});p.quantity({currentTarget:{dataset:{id:'bacon'}},detail:{value:'自己的用量'}});api.failWrite=true;p.save();assert.equal(calls.filter(c=>c[0]==='back').length,0);assert.equal(p.data.draft.items.find(i=>i.id==='bacon').quantity,'自己的用量');api.failWrite=false;p.save();assert.equal(store.meal(id).data.items.find(i=>i.id==='bacon').quantity,'自己的用量');assert.equal(calls.filter(c=>c[0]==='back').length,1);p.save();assert.equal(calls.filter(c=>c[0]==='back').length,1);
});
test('an old adjustment draft never rolls back later shopping checks or untouched quantities',()=>{
 const {store,H,M}=meal(),id=store.meal().id;const {instance:first}=page('adjust',store);first.onLoad({id});first.notes({detail:{value:'小火慢炖'}});
 store.change(h=>H.updateMealData(h,M.updateItem(M.updateItem(store.meal(id).data,'bacon',{status:'bought'}),'beef',{quantity:'另一次已更新的用量'})));
 const {instance:resumed}=page('adjust',store);resumed.onLoad({id});resumed.save();assert.equal(store.meal(id).data.items.find(i=>i.id==='bacon').status,'bought');assert.equal(store.meal(id).data.items.find(i=>i.id==='beef').quantity,'另一次已更新的用量');assert.equal(store.meal(id).data.notes,'小火慢炖');
});
test('conflicting adjustment keeps current quantities and pending input, without returning',()=>{
 const {store,H,M}=meal(),id=store.meal().id,{instance:p,calls}=page('adjust',store);p.onLoad({id});p.quantity({currentTarget:{dataset:{id:'bacon'}},detail:{value:'草稿用量'}});
 store.change(h=>H.updateMealData(h,M.updateItem(store.meal(id).data,'bacon',{quantity:'已保存的新用量'})));p.save();assert.equal(store.meal(id).data.items.find(i=>i.id==='bacon').quantity,'已保存的新用量');assert.equal(p.data.draft.items.find(i=>i.id==='bacon').quantity,'草稿用量');assert.equal(calls.filter(c=>c[0]==='back').length,0);assert.match(p.data.error,/已被修改/);
});
test('returning from adjustments or switching dishes restores expanded materials with the reading position',()=>{
 const {store}=meal(),id=store.meal().id,{instance:p}=page('cook',store);p.onLoad({id});p.onShow();p.toggleMaterials();p.onScroll({detail:{scrollTop:1200}});p.onHide();p.onShow();assert.equal(p.data.materialsOpen,true);assert.equal(p.data.scrollTop,1200);p.choose({currentTarget:{dataset:{id:'rice'}}});assert.equal(p.data.materialsOpen,false);p.choose({currentTarget:{dataset:{id:'beef'}}});assert.equal(p.data.materialsOpen,true);assert.equal(p.data.scrollTop,1200);
});
