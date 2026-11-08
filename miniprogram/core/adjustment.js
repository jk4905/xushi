'use strict';
const M=require('./meal');
function mergeAdjustment(current,base,draft) {
  if(![current,base,draft].every(M.validate)) throw new Error('本餐调整草稿无法读取，请重新打开。');
  let next=JSON.parse(JSON.stringify(current));
  for(const item of draft.items) {
    const original=base.items.find(old=>old.id===item.id);
    if(!original) {
      const existing=next.items.find(row=>row.name===item.name);
      if(existing) {
        if(existing.quantity!==item.quantity||existing.choice!==item.choice)throw new Error(item.name+'已在本餐中，请核对后重新调整。');
        if(item.dish.split('、').every(name=>existing.dish.split('、').includes(name)))continue;
      }
      next=M.addItem(next,item.name,item.dish);
      const added=next.items.find(row=>row.name===item.name);
      next=M.updateItem(next,added.id,{quantity:item.quantity,choice:item.choice});
      continue;
    }
    const patch={};
    for(const key of ['quantity','choice'])if(item[key]!==original[key])patch[key]=item[key];
    const newDishes=item.dish.split('、').filter(name=>!original.dish.split('、').includes(name));
    if(!Object.keys(patch).length&&!newDishes.length)continue;
    const latest=next.items.find(row=>row.id===item.id&&row.name===item.name);
    if(!latest)throw new Error('本餐菜品或材料已改变，请放弃旧调整后重新编辑。');
    for(const key of Object.keys(patch))if(latest[key]!==original[key]&&latest[key]!==patch[key])throw new Error(item.name+'的用料已被修改，请先核对当前记录。');
    next=M.updateItem(next,item.id,patch);
    if(newDishes.length) {
      const updated=next.items.find(row=>row.id===item.id);
      updated.dish=[...new Set([...updated.dish.split('、'),...newDishes])].join('、');
    }
  }
  if(draft.notes!==base.notes) {
    if(current.notes!==base.notes&&current.notes!==draft.notes)throw new Error('本餐备注已有更新，请先核对当前记录。');
    next=M.setNotes(next,draft.notes);
  }
  return next;
}
module.exports={mergeAdjustment};
