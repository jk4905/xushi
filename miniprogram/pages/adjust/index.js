const {store,H,M}=require('../../core/store');
const ui=require('../../core/ui');
const {mergeAdjustment}=require('../../core/adjustment');
Page({
 data:{meal:null,draft:null,error:'',saving:false,keyboard:false,addName:'',dishIndex:0,dishes:[],choices:['保留','不放','待定']},
 onLoad(options){
   this.mealId=options.id;this.key='adjust-'+this.mealId;
   const meal=store.meal(this.mealId);if(!meal){this.setData({error:'这餐不存在，请返回重新选择。'});return;}
   const saved=store.draft(this.key),h=store.get();
   this.base=saved&&M.validate(saved.base)?saved.base:meal.data;
   const draft=saved&&M.validate(saved.draft)?saved.draft:meal.data;
   this.setData({meal,draft,dishes:meal.recipeIds.map(id=>h.recipes.find(r=>r.id===id).name)});this.relabel();
 },
 relabel(){this.setData({rows:this.data.draft.items.map(i=>({...i,choiceIndex:{include:0,omit:1,pending:2}[i.choice]}))});},
 remember(){try{store.saveDraft(this.key,{base:this.base,draft:this.data.draft});}catch(error){ui.error(this,error);}},
 quantity(event){try{this.setData({draft:M.updateItem(this.data.draft,event.currentTarget.dataset.id,{quantity:event.detail.value})});this.remember();}catch(error){ui.error(this,error);}},
 choice(event){try{this.setData({draft:M.updateItem(this.data.draft,event.currentTarget.dataset.id,{choice:['include','omit','pending'][Number(event.detail.value)]})});this.relabel();this.remember();}catch(error){ui.error(this,error);}},
 notes(event){try{this.setData({draft:M.setNotes(this.data.draft,event.detail.value)});this.remember();}catch(error){ui.error(this,error);}},
 name(event){this.setData({addName:event.detail.value});},dish(event){this.setData({dishIndex:Number(event.detail.value)});},
 add(){try{this.setData({draft:M.addItem(this.data.draft,this.data.addName,this.data.dishes[this.data.dishIndex]),addName:''});this.relabel();this.remember();}catch(error){ui.error(this,error);}},
 focus(){this.setData({keyboard:true});},blur(){this.setData({keyboard:false});},
 save(){
   if(this.data.saving||this.committed)return;this.setData({saving:true,error:''});
   try{
     const meal=store.meal(this.mealId);if(!meal||meal.status!=='planned')throw new Error('这餐已结束，请先恢复再调整。');
     store.commit(H.updateMealData(H.selectMeal(store.get(),this.mealId),mergeAdjustment(meal.data,this.base,this.data.draft)));
     this.committed=true;
     try{store.clearDraft(this.key);}catch(_){ui.toast('用料已保存；草稿清理未完成');}
     ui.back(ui.mealUrl('shopping',this.mealId));
   }catch(error){ui.error(this,error);}finally{this.setData({saving:false});}
 },
 async cancel(){
   if(!await ui.confirm({title:'放弃本次调整？',content:'已保存的本餐用料不会改变。',confirmText:'放弃调整'}))return;
   try{store.clearDraft(this.key);ui.back(ui.mealUrl('shopping',this.mealId));}catch(error){ui.error(this,error);}
 }
});
