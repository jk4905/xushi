# 煦食 · H5

入口：`weekend-menu-prototype.html`。页面、`weekend-menu-c.css`、`weekend-household-model.js` 和 `weekend-household-seed.js` 需放在同一目录。当前试用包在无本地记录时自动保存 3 道菜谱和 2 个测试餐次；已有记录不覆盖，合法旧 v1 仍优先迁移。

打开方式、测试命令见 [项目 README](../README.md)。`weekend-menu-phone.cjs` 是已有的同 Wi-Fi 手机预览入口；手动运行时只提供入口页面及固定的样式、模型和初始数据脚本，手机修改不会传回电脑。

保留现有文件名以减少迁移影响。后续需求必须同时维护 [微信小程序](../miniprogram/)，遵循 [双端维护约定](../docs/dual-platform.md)。

H5 的餐次 / 家庭模型与原始菜谱是当前共享逻辑来源。修改后在根目录执行 `npm run sync` 与 `npm test`。
