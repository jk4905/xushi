# 煦食双端交互规格

核对日期：2026-11-08。范围为当前 [H5 交互源码][h5]、`miniprogram/` 源码及测试；历史静态设计图不作为实现证据。本文记录现状，不新增需求。

- **[代码可证实现]**：可由入口、处理函数、模型或测试断言确认；不等于浏览器、微信编译器或真机验收。
- **[已知差异]**：当前两端行为不同，不能写成共同保证。
- **[待验证]**：需要运行环境或人工操作确认，当前没有相应验收证据。
- 已确认产品约束：完整做法连续阅读、不分步确认、单次开始下厨、显式完成整餐；缺少原文的材料、用量与做法不补造。

## 两个 Tab 的职责

| Tab | 职责与入口 | 证据 |
|---|---|---|
| 做饭 | [代码可证实现] 当前餐、安排一餐、继续采购或做饭；「全部餐次」为二级入口，按待做／做过／已取消查看。 | H5 `homeView/planView/updateScreenAction`；[小程序首页][home]、[历史页][history] |
| 菜谱 | [代码可证实现] 收藏、搜索和编辑菜谱；管理常做菜单；进入设置与备份。菜谱与菜单是页内分段，不是额外 Tab。 | H5 `libraryView/libraryResults`；[小程序菜谱页][library]、[Tab 配置][app] |

## 核心状态转换

[代码可证实现] 餐次业务状态只有 `planned/completed/cancelled`。「正在下厨」由阅读辅助记录表达，开始、换菜、读到末尾都不把 `planned` 改为 `completed`。采购与本餐用料按餐次隔离，阅读按餐次及菜谱隔离。

| 进入状态 | 用户操作 | 业务变化 | 成功去向／反馈 | 取消、失败与恢复 |
|---|---|---|---|---|
| 无待做餐 | 安排第一餐 | 先形成选菜草稿，不创建餐次 | 进入选菜；至少选一道才可开始准备 | 返回保留已暂存草稿；未提交不创建餐 |
| 选菜中 | 开始准备 | 创建 `planned` 餐及本餐材料快照；餐名、日期可空 | 进入该餐采购页；编辑已有餐或菜单则返回来源 | 保存失败留页保留选择；小程序跳转失败后「继续准备」只重试跳转 |
| 待做／采购中 | 勾选或取消一项 | 仅改该行采购状态，不完成餐次 | 原行更新，不主动重排或滚动 | [已知差异] 两端取消值、保存失败反馈不同，见下文 |
| 待做／采购中 | 一次点击「开始做饭」 | 写入阅读辅助状态，餐仍为 `planned` | 直接打开完整做法；不要求先买齐、补齐用量或通过 `reviewed` 核对 | [已知差异] 小程序辅助存储失败会提示并留采购页；H5 可进入阅读并提示位置未保存 |
| 连续阅读 | 滚动、换菜、展开用料、离开后返回 | 仅更新位置、当前菜与用料展开状态 | 恢复对应餐／菜的阅读记录 | 缺做法显示未记录与补充入口；读到最后不触发完成 |
| 采购／阅读 | 本餐调整 | 只改本餐材料、取舍与备注，不覆盖菜谱 | 保存返回来源；阅读来源恢复位置 | [已知差异] H5 自动保存，小程序草稿提交；详见编辑约定 |
| 待做／阅读中 | 完成整餐并确认 | `planned → completed` | [已知差异] H5 进入「全部餐次／做过」；小程序回做饭根页 | 取消确认不改餐；写入失败保留来源与输入，可重试 |
| 待做／已取消 | 确认取消／恢复这餐 | `planned → cancelled`／恢复为 `planned`，保留本餐数据 | [已知差异] H5 恢复后进入采购或阅读；小程序恢复后留在历史页「待做」 | 取消确认不写入；保存失败提示，保留原状态 |
| 设置与备份 | 导出／确认导入 | 导出不改餐；导入替换家庭数据 | 留在备份页反馈；导入附带辅助记录处理 | 取消导入不替换；格式、容量、存储失败处理见备份表 |

除标注差异外，上表为 **[代码可证实现]**。证据：H5 `handleHouseholdAction/startCooking/change`、[共享餐次模型][model]、小程序 [选菜][builder]／[采购][shopping]／[阅读][cook]／[历史][history]；回归见 [H5 流程][h5-tests]、[小程序流程][flow-tests]、[选菜与历史测试][builder-tests]。

## 导航与阅读恢复

| 核对点 | H5 | 小程序 |
|---|---|---|
| [已知差异] 切 Tab 再回来 | `tabStacks` 分别保留两栏详情栈、来源餐与滚动；`selectTab` 回该栏栈顶。 | `app-tabs.go` 调用 `wx.switchTab` 回目标根页，不恢复原子页面栈。回做饭后点「接着准备／接着做饭」，由 `home.resume` 再进入采购／阅读。 |
| [已知差异] 重按当前 Tab | 当前栏不导航，保留详情现场。 | 根页不导航；子页点击当前栏仍回该栏根页。失败提示可重试。 |
| [已知差异] 阅读位置 | `rememberCookingProgress` 保存段落索引 `step`、段落相对视口的 `offset` 及展开状态；恢复时查找 `data-reader-step` 锚点计算滚动。 | `cook.onScroll/store.setReading` 保存像素 `scrollTop`；`readerViews` 按菜谱重建 `scroll-view` 并设置 `scroll-top`，另存展开状态。 |
| [已知差异] 保存期限 | 家庭数据在 `localStorage`；阅读、导航、选菜及菜谱／链接草稿在 `sessionStorage`，支持同会话刷新恢复，不承诺关闭会话后保留。 | 家庭数据和阅读／草稿分别写微信本地存储；测试覆盖重新创建 store 后恢复。两端没有自动设备同步。 |

证据：H5 `rememberPage/readNavigationStack/selectTab/restoreReadingPosition`（[导航源码][h5-nav]、[阅读源码][h5-reader]）；小程序 [Tab 组件][tabs]、[首页][home]、[阅读页][cook]、[存储层][store]。测试：[H5 双 Tab 与滚动][h5-prototype-tests]、[H5 锚点恢复][h5-tests]、[小程序根页切换][tab-tests]、[独立位置持久化][core-tests]。

## 编辑页、底部操作与本餐调整

| 场景 | H5 | 小程序 |
|---|---|---|
| [已知差异] 选菜／菜单编辑 | `select` 主页面保留 Tab，底部为「开始准备／保存并返回／保存菜单」；切 Tab 暂存选菜、搜索及页内分段。 | `builder` 是独立编辑页，无 `app-tabs`；底部固定主操作，返回保留草稿。 |
| [已知差异] 菜谱／链接编辑 | 模态 sheet 阻止底层 Tab 切换；底部「取消」与「保存菜谱／保存并选中」。取消或关闭保留菜谱／链接草稿，明确放弃菜谱草稿需确认。 | `recipe-edit` 独立页，无 Tab；底部「保存菜谱」，系统返回暂存草稿；「放弃草稿」需确认并重载已保存内容。 |
| [已知差异] 本餐调整提交 | `recipe-edit` 路由实际是本餐调整，保留 Tab。用量、取舍、备注即时调用 `change` 自动保存；底部「保存并返回」在未落盘时重试。退出不撤销已自动保存内容。 | `adjust` 无 Tab；编辑先写独立草稿，底部「完成调整」才合并并提交。确认「放弃本次调整」清草稿，保留已保存本餐。 |
| [代码可证实现] 修改范围 | 两端用量或取舍实际变化只将受影响材料重置为 `unchecked`；单改备注不清其他采购项；原菜谱保留。 | 小程序额外通过 `mergeAdjustment` 合并旧草稿，保留之后发生的未触及修改，冲突留页提示。 |

[代码可证实现] 菜谱完整编辑更新菜谱；已安排餐次的材料快照不重建，后续阅读使用更新后的菜谱做法。保存失败留输入，不能当作已保存；主保存成功后的草稿清理失败，小程序单独提示。

[已知差异] H5 自动保存失败时内存仍显示本次修改，并提示未保存；小程序采购需写入并读回确认后才更新勾选，失败维持原勾选。采购取消在 H5 写 `unchecked`，小程序写 `to-buy`，两者都显示为未备齐，字段值并不相同。

[已知差异] 键盘适配：H5 使用 `visualViewport` 调整页面高度／sheet 避让；小程序编辑页键盘打开时以 `.keyboard-action` 将底部操作改为普通文档流。按钮实际可达仍待设备验证。

证据：H5 `openHouseholdSheet/updateScreenAction/change/purchase/finish-adjustment`；小程序 [菜谱编辑][recipe-edit]、[选菜][builder]、[本餐调整][adjust]、[草稿合并][adjustment]、[采购页][shopping]。Tab 与底部按钮见 [编辑模板][recipe-edit-view]／[选菜模板][builder-view]／[调整模板][adjust-view]，键盘样式见 [app.wxss][styles]；回归见 [H5 调整失败恢复][h5-tests]、[小程序调整冲突][flow-tests]、[菜谱保存与草稿][library-tests]。

## 链接录入与缺失原文

- [代码可证实现] 从菜谱或选菜页添加；菜名必填，链接按模型规范化及校验，接受合法 HTTP(S)，拒绝脚本协议、嵌入凭据等；不请求第三方正文、不自动解析视频。
- [已知差异] H5 链接 sheet 只录链接与菜名，再另开完整编辑；小程序同页可展开材料与做法，无链接时须填写材料。已有链接的菜谱可暂缺材料／做法。
- [已知差异] H5 从选菜页保存链接后自动选中该菜；小程序保存返回后只刷新列表，保留原选择，新菜仍需手动勾选。两端均可先保存链接，再安排无材料记录的一餐。
- [已知差异] 同链接不新增第二条：H5 返回已有菜谱、不覆盖原内容；小程序若本次菜名或已填材料／做法与已有内容不同，留页提示并保留输入，不静默放弃。
- [已知差异] H5 通过带 `noopener noreferrer` 的链接另页打开原做法；小程序菜谱详情／阅读页复制链接，提示去浏览器查看。复制失败有错误反馈。
- [代码可证实现] 完整做法一次连续展示，无逐步完成按钮；原始牛肉十段保留，西兰花、米饭缺失做法仍为空，西芹不因步骤缺失而删去，用量未知明确显示未记录。

证据：[链接模型][model]、H5 `save-link/sourceLink/cookView`、[小程序菜谱编辑][recipe-edit]／[阅读页][cook]；测试 [首次链接流程与缺做法][h5-tests]、[新菜不自动勾选][builder-tests]、[重复链接输入保护][library-tests]、[原始配方][core-tests]。

## 明确完成与备份

[代码可证实现] H5「完成这餐」、小程序「这餐做好了」均二次确认。阅读结尾只提示完成入口；点取消或关闭确认不变更餐次。完成是整餐状态，不是某道菜或某段做法的勾选。成功去向存在上表已列差异。

| 核对项 | H5 | 小程序 |
|---|---|---|
| [代码可证实现] 格式 | 导出家庭 schema v2；导入校验 v2 或迁移合法 v1。只导出家庭记录，不包含阅读／编辑辅助草稿。 | 同左；格式兼容不等于导入结果完全一致。 |
| [已知差异] 导入后采购 | 所有 `planned` 餐的材料状态重置为 `unchecked`，完成／取消餐的采购状态保留；提示重新核对采购。 | `importText` 直接保存校验／迁移结果，保留备份中的采购状态，含 `bought/at-home`。 |
| [已知差异] 阅读与草稿 | 清阅读、当前菜、选菜草稿，重建应用导航栈；清已有菜谱的编辑草稿；保留无 ID 的新增菜谱草稿及独立链接草稿。 | 清空全部 `metadata.drafts/cooking`，包含新增菜谱、已有菜谱、选菜、本餐调整草稿；用新 epoch 隔离旧辅助缓存。 |
| [已知差异] 导入前保护 | 没有自动保存整份旧家庭副本的流程，确认文案要求有需要先取消、保存草稿并导出。 | 替换前保留本地旧主记录副本；可在备份页复制上次导入前副本后再次导入。 |
| [已知差异] 导入失败恢复 | 先重置会话缓存，缓存写失败则停止；家庭保存失败尝试回滚缓存，保留确认供重试。 | 主记录写入并读回确认后才切换内存；辅助记录重置失败时，主数据已导入，提示重试重置；新 epoch 阻止旧草稿复活。 |
| [已知差异] 文件与容量 | JSON 文件下载／文件选择导入，单份上限 32,000,000 字节；提示「已开始导出，请确认文件保存完成」。 | 文件分享或复制文本；微信文件选择或粘贴导入；导入上限 4 MiB，有效家庭数据上限 900 KiB，不截断。 |

[代码可证实现] 非法备份、用户取消确认均不替换家庭数据。小程序主写入已发生但读回失败时会报未确认成功，重试保留原导入前副本；不能将所有存储错误概括为「磁盘完全未改变」。H5 缓存回滚也可能再遇写失败，不能承诺存储不可用时绝对恢复。

证据：[H5 导入事件][h5-import]（`import-file`）、H5 `export`、[小程序备份页][backup]、[存储层 `importText/write`][store]；测试 [H5 导入采购重置与草稿保留][h5-tests]、[小程序 v1/v2 状态往返及 epoch][core-tests]。

## 试用初始数据与验证边界

- [代码可证实现] 2026-11-09 按用户要求，当前试用包首次启动、无本地记录时自动保存 3 道菜谱与 2 个测试餐次，当前为“今晚这餐”。采购状态和本餐备注原样保留；读取已有数据（含已保存的空库）不重新初始化，损坏记录不覆盖。H5 有合法旧 v1 时优先迁移。
- [代码可证实现] 首次写入后回读核对；写入或回读失败显示暂未保存，不假报持久化成功。当前会话保留试用数据，可在存储恢复后修改记录重试，或重新打开；重试不追加重复餐次。阅读位置及未保存草稿不在内置快照中。
- [已知差异] 小程序空菜谱页有「添加原始三道菜谱」，点击才加入且不创建餐；H5 当前入口没有对应示例按钮，但发现合法旧 v1 本地记录会自动迁移读取，小程序需通过备份导入 v1。
- [代码可证实现] 回归包含两端首次保存、重新读取、已有记录与空库保护、损坏数据保护、保存失败重试及共享源同步。具体运行结果见 [验证记录](validation.md)；测试桩不证明真实平台效果。
- [待验证] 两端实际 Tab 往返、系统返回、键盘遮挡、底部按钮可达、安全区及无障碍；小程序 `wx.switchTab` 的真实生命周期与再次进入阅读效果。
- [待验证] 字体、屏幕尺寸、图片加载或做法编辑后的位置恢复；尤其像素 `scrollTop` 不保证跨排版保持同一段。实际下载／分享／复制的最终文件与跨端设备导入也须单独核验。
- [待验证] iPhone 真机、H5 浏览器渲染与真实做饭体验仍须单独验证；微信模拟器检查范围见 [验证记录](validation.md)。

初始化证据：H5 `loadHousehold`、[试用数据源](../h5/weekend-household-seed.js) 与 [首次使用测试][h5-tests]；小程序 [store.load/addExamples][store]、[菜谱页][library] 与 [初始化及空库测试][core-tests]。

[h5]: ../h5/weekend-menu-prototype.html#L590
[h5-nav]: ../h5/weekend-menu-prototype.html#L1148
[h5-reader]: ../h5/weekend-menu-prototype.html#L710
[h5-import]: ../h5/weekend-menu-prototype.html#L1235
[model]: ../h5/weekend-household-model.js
[app]: ../miniprogram/app.json
[tabs]: ../miniprogram/components/app-tabs/index.js
[home]: ../miniprogram/pages/home/index.js
[history]: ../miniprogram/pages/history/index.js
[library]: ../miniprogram/pages/library/index.js
[builder]: ../miniprogram/pages/builder/index.js
[shopping]: ../miniprogram/pages/shopping/index.js
[cook]: ../miniprogram/pages/cook/index.js
[recipe-edit]: ../miniprogram/pages/recipe-edit/index.js
[adjust]: ../miniprogram/pages/adjust/index.js
[adjustment]: ../miniprogram/core/adjustment.js
[backup]: ../miniprogram/pages/backup/index.js
[store]: ../miniprogram/core/store.js
[h5-tests]: ../h5/weekend-menu-app-check.cjs
[h5-prototype-tests]: ../h5/weekend-menu-prototype-check.cjs
[tab-tests]: ../miniprogram/tests/app-tabs.test.cjs
[core-tests]: ../miniprogram/tests/core.test.cjs
[flow-tests]: ../miniprogram/tests/flow.test.cjs
[builder-tests]: ../miniprogram/tests/builder-pages.test.cjs
[library-tests]: ../miniprogram/tests/library-pages.test.cjs
[recipe-edit-view]: ../miniprogram/pages/recipe-edit/index.wxml
[builder-view]: ../miniprogram/pages/builder/index.wxml
[adjust-view]: ../miniprogram/pages/adjust/index.wxml
[styles]: ../miniprogram/app.wxss
