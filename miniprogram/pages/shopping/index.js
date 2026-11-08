const {store,H,M}=require('../../core/store');
const ui=require('../../core/ui');
Page({
 data:{meal:null,items:[],error:'',busy:false,prepared:0,total:0},
 onLoad(options){this.mealId=options.id;},
 onShow(){this.refresh();},
 refresh(){
   const meal=store.meal(this.mealId);if(!meal){this.setData({meal:null,error:'没有找到这餐，请从做饭页重新选择。'});return;}
   const h=store.get(),summary=M.summary(meal.data);
   this.setData({meal,items:meal.data.items.filter(i=>i.choice==='include').map(i=>({...i,checked:['bought','at-home'].includes(i.status)})),prepared:summary.bought+summary.atHome,total:summary.required,pending:summary.unresolvedChoices,missing:meal.recipeIds.map(id=>h.recipes.find(r=>r.id===id)).filter(r=>!r.items.length).map(r=>r.name),error:store.issue()});
 },
 toggle(event){
   if(this.data.busy||this.data.meal?.status!=='planned')return;
   const index=Number(event.currentTarget.dataset.index),item=this.data.items[index];if(!item)return;
   this.saveStatus(index,item.checked?'to-buy':'bought');
 },
 homeStock(event){
   const index=Number(event.currentTarget.dataset.index);if(this.data.meal?.status!=='planned')return;
   wx.showActionSheet({itemList:['家里已有','还需要买'],success:res=>this.saveStatus(index,res.tapIndex===0?'at-home':'to-buy')});
 },
 saveStatus(index,status){
   this.setData({busy:true});
   try{
     const meal=store.meal(this.mealId),item=this.data.items[index];
     if(!meal||meal.status!=='planned'||!item)throw new Error('这餐已结束，请恢复后再修改。');
     const next=H.updateMealData(H.selectMeal(store.get(),meal.id),M.updateItem(meal.data,item.id,{status}));
     store.commit(next);
     const summary=M.summary(store.meal(meal.id).data);
     // Update only this stable row; never reorder or scroll after checking.
     this.setData({['items['+index+'].status']:status,['items['+index+'].checked']:['bought','at-home'].includes(status),prepared:summary.bought+summary.atHome,error:''});
   }catch(error){ui.error(this,error);}finally{this.setData({busy:false});}
 },
 adjust(){wx.navigateTo({url:ui.mealUrl('adjust',this.mealId)});},
 start(){
   if(this.data.busy)return;
   try{store.startCooking(this.mealId);wx.navigateTo({url:ui.mealUrl('cook',this.mealId)});}catch(error){ui.error(this,error);}
 },
 home(){wx.switchTab({url:'/pages/home/index'});}
});
