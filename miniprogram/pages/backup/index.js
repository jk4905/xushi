const {store,IMPORT_LIMIT}=require('../../core/store');
const ui=require('../../core/ui');
Page({
 data:{error:'',busy:false,importText:'',keyboard:false},
 onShow(){const h=store.get();this.setData({recipes:h.recipes.length,meals:h.meals.length,error:store.issue()});},
 input(event){this.setData({importText:event.detail.value});},focus(){this.setData({keyboard:true});},blur(){this.setData({keyboard:false});},
 copy(){try{wx.setClipboardData({data:store.exportText(),success:()=>ui.toast('备份已复制，请保存到自己的文件中'),fail:()=>ui.error(this,new Error('复制失败，请重试。'))});}catch(error){ui.error(this,error);}},
 raw(){try{const data=store.rawText();if(!data)throw new Error('没有可导出的原始记录。');wx.setClipboardData({data,success:()=>ui.toast('原始记录已复制'),fail:()=>ui.error(this,new Error('复制失败，请重试。'))});}catch(error){ui.error(this,error);}},
 exportFile(){
   if(this.data.busy)return;this.setData({busy:true,error:''});
   let data;try{data=store.exportText();}catch(error){ui.error(this,error);this.setData({busy:false});return;}
   const path=wx.env.USER_DATA_PATH+'/xushi-backup.json';
   wx.getFileSystemManager().writeFile({filePath:path,data,encoding:'utf8',success:()=>{
     // Opens the system share picker; the user chooses a destination and sends it.
     if(wx.shareFileMessage)wx.shareFileMessage({filePath:path,fileName:'煦食备份.json',fail:()=>ui.error(this,new Error('文件已生成；分享未完成，可重试或复制备份。')),complete:()=>this.setData({busy:false})});
     else {this.setData({busy:false});ui.error(this,new Error('当前微信版本不支持文件分享，请使用复制备份。'));}
   },fail:()=>{ui.error(this,new Error('备份文件未能写入，请检查设备空间。'));this.setData({busy:false});}});
 },
 chooseFile(){wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:res=>{
   const file=res.tempFiles[0];if(!file)return;if(file.size>IMPORT_LIMIT){ui.error(this,new Error('备份文件过大，最多4 MB。'));return;}
   wx.getFileSystemManager().readFile({filePath:file.path,encoding:'utf8',success:res=>this.setData({importText:res.data,error:''}),fail:()=>ui.error(this,new Error('文件读取失败，原记录未改变。'))});
 },fail:err=>{if(!/cancel/.test(err.errMsg||''))ui.error(this,new Error('未能读取文件，可直接粘贴备份内容。'));}});},
 async restore(){
   if(this.data.busy||!this.data.importText.trim())return;
   if(!await ui.confirm({title:'用备份恢复本机？',content:'将替换当前菜谱、餐次和菜单。现有记录会先留一份本地副本，阅读位置和草稿会清空。',confirmText:'恢复备份'}))return;
   this.setData({busy:true});
   try{store.importText(this.data.importText);this.setData({importText:'',error:store.issue()});this.onShow();ui.toast('备份已恢复');}catch(error){ui.error(this,error);}finally{this.setData({busy:false});}
 },
 previous(){
   try{const {KEY}=require('../../core/store');const data=wx.getStorageSync(KEY+'-before-import');if(!data)throw new Error('尚无导入前副本。');let text=typeof data==='string'?data:JSON.stringify(data);try{const parsed=JSON.parse(text);if(parsed.storageVersion===1&&parsed.household)text=JSON.stringify(parsed.household);}catch(_){}wx.setClipboardData({data:text,success:()=>ui.toast('副本已复制，粘贴后可恢复'),fail:()=>ui.error(this,new Error('复制失败，请重试。'))});}catch(error){ui.error(this,error);}
 },
 async resetMeta(){if(!await ui.confirm({title:'重置阅读位置与草稿？',content:'菜谱、餐次和采购勾选保留。',confirmText:'重置'}))return;try{store.resetMeta();this.onShow();ui.toast('辅助记录已重置');}catch(error){ui.error(this,error);}}
});
