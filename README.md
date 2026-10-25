# 芯位蜜线网课自动连播与章节导航助手（Tampermonkey 油猴脚本）

**Beeline Autocourse Userscript / 芯位蜜线自动刷课脚本**

[![CI](https://github.com/zzs4057/beeline-autocourse/actions/workflows/ci.yml/badge.svg)](https://github.com/zzs4057/beeline-autocourse/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/zzs4057/beeline-autocourse?style=social)](https://github.com/zzs4057/beeline-autocourse/stargazers)
![License](https://img.shields.io/badge/license-MIT-yellow.svg)
![Userscript](https://img.shields.io/badge/userscript-Tampermonkey%20%7C%20Violentmonkey-blue)
![Version](https://img.shields.io/badge/version-1.4.0-green)

[仓库地址](https://github.com/zzs4057/beeline-autocourse)

一个面向 `beeline-ai.com` 芯位蜜线课程学习页的 Tampermonkey / Violentmonkey 油猴脚本，支持网课自动连播、自动下一节、课程章节导航、PPT 课件跳过、空节点跳过、折叠章节目录定位和视频加载保护。发布版采用前台守卫模式，不伪造页面可见性，不调用平台学习接口，不修改课程数据。

常见搜索方式包括“芯位蜜线刷课脚本”“芯位蜜线自动刷课”“芯位蜜线自动连播”“芯位蜜线油猴脚本”“Beeline AI userscript”和“Beeline autocourse”。项目名称中的 Autocourse 指课程导航与自动连播，不代表伪造学习进度。

> 本项目与芯位蜜线官方无关。请遵守平台服务条款、课程规则和当地法律法规。

如果这个项目对你有帮助，欢迎点击仓库右上角的 **Star**，方便后续找到更新。

## 搜索关键词

`芯位蜜线`、`芯位蜜线刷课`、`芯位蜜线刷课脚本`、`芯位蜜线自动刷课`、`芯位蜜线自动连播`、`芯位蜜线自动下一节`、`芯位蜜线油猴脚本`、`芯位蜜线 Tampermonkey`、`网课自动连播`、`网课章节导航`、`PPT 课件跳过`、`课件自动跳过`、`空节点跳过`、`折叠章节展开`、`Beeline AI userscript`、`Beeline autocourse`。

## 功能

- 识别“观看下一章节”弹窗，并严格排除“重新观看本节”等按钮。
- 只接受“明确文案 + 可见弹窗 + 屏幕命中”的自动点击目标。
- 识别静止 PPT/PDF 文档查看器，并跳转到下一个带时长的视频。
- 识别“该节点暂无文件”“暂无内容”等空节点并继续下一视频。
- 支持 Element UI 折叠菜单与 `第N讲/第N章` 自定义折叠标题。
- 当下一视频位于折叠章节时，先展开相邻章节，再重新定位。
- 多个 `<video>` 并存时，只使用当前可见或正在播放的主视频。
- 视频加载、缓冲、`seeking` 或显示 loading spinner 时不判定为完成。
- 课程窗口失焦时暂停自动操作，恢复前台后再继续。
- 提供控制面板、运行日志、页面结构诊断和手动跳转入口。

## 合规说明

本项目仅通过正常 DOM 操作辅助课程页面导航。

发布版明确不包含以下行为：

- 不伪造 `document.hidden`、`visibilityState` 或 `hasFocus()`。
- 不拦截平台的 `blur`、`visibilitychange` 等风控事件。
- 不随机点击页面控件来模拟在线行为。
- 不调用课程完成接口、学习进度接口或签到接口。
- 不修改平台返回的数据，不伪造学习时长或考核结果。

脚本无法保证平台不会记录访问或判定异常。使用者应遵守所在平台服务条款、课程规则和当地法律法规。平台要求课程窗口保持前台时，请保持窗口可见并位于最上方。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 打开 [`beeline-autocourse.user.js`](./beeline-autocourse.user.js)。
3. 在 GitHub 页面点击 `Raw`，或打开扩展的脚本管理页面后新建脚本并粘贴完整内容。
4. 保存脚本并刷新芯位蜜线课程页面。

脚本仅匹配：

```text
https://www.beeline-ai.com/*
https://beeline-ai.com/*
```

## 使用

进入课程学习页后，右下角会出现“芯位刷课助手”面板。

- **主控**：查看当前章节、播放进度和主要开关。
- **参数**：调整扫描间隔、点击延迟、课件停留时间和主循环间隔。
- **日志**：查看按钮识别、折叠章节展开、视频加载和跳转结果。
- **强制跳到下一视频**：跳过当前视频或静态内容，直接选择目录中下一个带时长的视频。
- **诊断**：输出播放器、章节列表、候选按钮和视频状态。

建议保持浏览器窗口在前台。切换标签页、最小化窗口或让播放器失焦时，脚本将停止自动操作。

## 默认行为

| 项目 | 默认值 | 说明 |
|---|---:|---|
| 自动下一节 | 开启 | 检测到符合条件的目标后继续下一节 |
| 防跳过头 | 开启 | 视频未到末尾时不自动跳转 |
| 自动跳课件/空节点 | 开启 | 停留后进入下一视频 |
| 暂停自动续播 | 开启 | 仅在前台恢复播放 |
| 默认倍速 | `1x` | 建议遵守课程平台规则 |
| 扫描间隔 | `10s` | 独立扫描下一章节入口 |
| 静态课件停留 | `5s` | 等待文档查看器渲染 |

## 已知限制

- 跨域 iframe 内的播放器和目录无法直接读取。
- Shadow DOM 内的按钮需要平台暴露可访问节点。
- 平台 DOM 大改后，选择器和状态判断可能需要更新。
- “普通教学视频”和“PPT 录屏视频”在 DOM 上可能完全相同，脚本不会仅凭画面内容自动跳过普通视频。
- 如果平台服务端强制要求完成课件或保持前台，脚本不能绕过该限制。

## 隐私

- 配置保存在浏览器 `localStorage`。
- 运行日志只保存在当前页面内存中。
- 脚本不向第三方服务器发送课程、账号或播放数据。
- 仓库和脚本均不包含登录凭据、Cookie 或访问令牌。

## 开发与测试

环境要求：Node.js 20 或更高版本。

```bash
npm run check
npm test
```

当前精简测试集覆盖：

- 主流程与课件/空节点/折叠章节跳转；
- 下一章节按钮误识别防护；
- 配置校验；
- 点击闸门；
- 随机 DOM 强化测试；
- 8 小时长时间模拟；
- HTML ID 与 CSS 类一致性。

## 目录结构

```text
.
├─ beeline-autocourse.user.js
├─ README.md
├─ LICENSE
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ CODE_OF_CONDUCT.md
├─ docs/
│  ├─ architecture.md
│  ├─ configuration.md
│  ├─ troubleshooting.md
│  └─ compliance.md
├─ tests/
│  ├─ run-all.mjs
│  └─ verify-*.mjs
└─ .github/
   ├─ workflows/ci.yml
   └─ ISSUE_TEMPLATE/
```

## 贡献

提交代码前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](./SECURITY.md) 的方式报告。

## 支持项目

如果项目解决了你的课程章节导航问题，欢迎前往 [Stargazers](https://github.com/zzs4057/beeline-autocourse/stargazers) 页面点一个 **Star**，或把仓库分享给需要的人。Star 可以帮助更多用户搜索到这个项目，也有助于后续更新和维护。

## 开源声明

本项目使用 [MIT License](./LICENSE) 开源。

Copyright (c) 2026 Beeline Autocourse Contributors

本项目与芯位蜜线及其关联公司无隶属或官方合作关系。平台名称和商标归其各自权利人所有。
