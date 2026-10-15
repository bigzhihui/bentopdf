# 十三月 PDF 工具

免费在线 PDF 工具，支持合并、拆分、压缩、转换、编辑和 OCR。基于 [BentoPDF](https://github.com/alam00000/bentopdf) 的中文定制版，部署在 Cloudflare Pages。

**[打开网站](https://pdf.afeiii.com)** · [使用说明](https://pdf.afeiii.com/faq) · [问题反馈](https://github.com/bigzhihui/bentopdf/issues) · [联系支持](mailto:support@afeiii.com)

## 这是什么

十三月 PDF 工具把常用的 PDF 操作放在浏览器中完成，无需注册。处理能力取决于浏览器、设备内存和文件本身；OCR 的识别结果需要自行核对。

文件处理在浏览器本地执行。网站仍需下载程序、WASM 引擎、字体和 OCR 数据；部分数字签名功能可能访问证书来源或已配置的 CORS 代理。具体说明见本站[隐私政策](https://pdf.afeiii.com/privacy)。

## 主要功能

| 分类       | 常用工具                                     |
| ---------- | -------------------------------------------- |
| 页面整理   | 合并、拆分、提取、删除、旋转、重排、添加页码 |
| 压缩与修复 | 多种压缩方式、修复、扁平化                   |
| 编辑与标注 | PDF 编辑、注释、印章、水印、裁剪             |
| 格式转换   | 图片与 PDF 互转、PDF 转 Word、文本提取       |
| 文字识别   | 中英文等语言的 OCR，可搜索 PDF               |
| 安全与信息 | 加密、解密、权限、元数据、数字签名相关工具   |

**本站未开放 13 个 Office 转 PDF 工具。** 这些功能依赖的 LibreOffice WASM 文件超过 Cloudflare Pages 的单文件限制，构建时移除引擎和对应入口。PDF 转 Word 不属于这组禁用工具。完整功能以[线上首页](https://pdf.afeiii.com/)为准。

## 相比上游的改动

- 中文品牌、默认语言、页面标题、站点地图和本站源码链接。
- 本站 About、Contact、FAQ、Privacy、Terms，中英文使用说明。
- Cloudflare Pages 构建：排除未开放工具和上游营销页面，生成安全头，检查文件大小。
- WASM、OCR 数据和字体部署到本站；字体下载限制并发并增加有限重试。
- 修复语言切换、分类展开及本地文件处理中的问题。
- 已合并上游 PDF 注释查看器文件来源校验；上游基线和定制提交保留在 Git 历史中。

## 本地开发

建议使用 Node.js 22.13+ 或 24，以及 npm。安装与开发：

```sh
npm ci
npm run dev
```

常用验证命令：

```sh
npx tsc --noEmit
npm run test:run
npm run test:upstream-sync
npm run build:pages
npx playwright install chromium
npm run test:smoke
```

## Cloudflare Pages 部署

- 构建命令：`npm run build:pages`。
- 输出目录：`dist`。
- 本站公开配置集中在 [cloudflare/pages-config.json](cloudflare/pages-config.json)：域名、品牌、13 个禁用工具、资源地址等，文件中不放密钥。
- 构建环境中已设置的同名变量优先生效。`SITE_URL` 改为其他域名时，相应资源地址也需调整；处理脚本会把同站资源放进构建产物。
- 原有构建命令 `npm run build && node scripts/cloudflare-pages.mjs` 仍可使用，需要自行提供同样的环境变量。
- 默认使用预览分支验收，合并 `main` 后由 Cloudflare 的生产部署配置决定是否自动上线。

通用自部署方式见[上游文档](https://bentopdf.com/docs/)。本站 Pages 配置与上游 Docker、Vercel 的部署方式分别维护。

## 跟进上游更新

[检查上游更新](.github/workflows/upstream-sync.yml) 每周一北京时间 10:23 运行，也可在 Actions 手动运行。

1. 检查上游主分支和最新正式版。
2. 有新提交时，在专用更新分支合并，保留本站改动；创建或更新一个**草稿 PR**。
3. 自动安排只读权限的类型检查、测试、Pages 构建和 SEO 检查，结果链接写入工作流摘要。
4. 人工检查品牌、翻译、资源地址、禁用工具和实际 PDF 操作，再决定合并。

发生合并冲突时工作流停止并标红；已进入人工审查的非草稿 PR 不会被自动重写。检查工作流只更新专用分支和草稿 PR，默认需人工合并；下述自动上线模式使用独立控制器。正式版和安全修复优先评估，普通主分支改动可以积累后处理。

工作流使用 GitHub 内置令牌，无需另存个人访问令牌。仓库需启用 Actions，并允许 Actions 创建 PR；仓库变量 `ENABLE_UPSTREAM_SYNC=true` 控制草稿 PR 功能，关闭时仍会执行只读检查。候选代码只在只读作业中运行，独立报告作业负责把验证结果关联到候选提交。

### 按改动范围自动上线（默认关闭）

自动上线代码与现有草稿 PR 检查分别控制。只有同时设置 `ENABLE_UPSTREAM_AUTOMERGE=true` 和 `ENABLE_PDF_ROLLBACK=true`，才会启用自动合并与部署验收；未设置或值为 `false` 时仍走原来的草稿 PR 流程。

| 更新范围                                                                      | 处理方式                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| `docs/tools/` 下的小篇幅 Markdown 工具说明、指定非中英文语言包的纯文本修正    | 在全部验证通过、生产与 main 一致后自动合并   |
| 中文或英文语言包、JSON 结构/链接/HTML/占位符变化、超过 20 个文件或 400 行增删 | 保留草稿 PR，等待审查                        |
| 引擎、WASM、OCR、源码、依赖、构建、品牌、工作流，以及其他未列入允许范围的文件 | 保留草稿 PR，等待审查                        |
| 合并冲突或验证失败                                                            | 停止上线，记录问题；自动模式下创建暂停 Issue |

分类作用于整个更新 PR，任一文件需要审查时，整个 PR 都不会自动合并。控制逻辑只执行默认分支的脚本；候选代码、浏览器和依赖安装均在只读作业运行，不接触 Cloudflare 密钥。原有自动化只更新专用分支；新增合并控制器在启用后通过带精确候选 SHA 的 GitHub 合并 API 操作 main，不绕过仓库保护规则。

自动验证新增真实浏览器检查：桌面/手机首页、本站源码与禁用入口、PDF 查看器预览与下载、两份虚拟 PDF 合并下载、跨域文件拦截。构建生成不缓存的 `build-info.json`，线上验收必须匹配目标提交，防止误验收旧版本。测试仅使用现场生成的虚拟 PDF，CI 只保留少量截图和结果，3 天后过期。

### 启用自动上线前的接入条件

1. 将这组代码审查合并到默认分支；预览与 CI 必须通过。
2. 为 main 设置分支保护：必需状态 `PDF validation`，并启用“要求分支在合并前保持最新”。控制器会核对这两个条件。
3. 在 GitHub Actions Secret 中设置 `CLOUDFLARE_API_TOKEN`，权限为当前账户的 **Cloudflare Pages Edit**；令牌不写入源码或普通变量。项目固定为 `bentopdf`。
4. 确认 Cloudflare 当前成功生产部署对应 main，且没有仍在运行的部署验收。
5. 最后显式开启上述两个仓库变量。它们的默认值均为关闭；提交代码不会代替启用操作。

生产验收会等待目标 Cloudflare 部署，分别检查不可变部署地址和正式域名。确认新版功能失败时，先创建带暂停标记的 Issue，再回退上一成功的生产部署；如果出现更新的 main 或部署，旧验收任务不会覆盖它。访问验证页、网络阻断、构建失败或等待超时会暂停自动更新并记录问题，不据此回退。

暂停 Issue 存在期间，自动合并停止，每周只读检查仍可继续。**Pages 回退只恢复生产文件，不撤销 Git 提交。** 处理人员需先修复或撤销 main 中的问题，确认生产、源码和验收一致，再关闭暂停 Issue 恢复自动合并。通知以仓库 Issue 和失败的 Actions 运行为准，可通过 GitHub 关注设置接收通知。

## 反馈与贡献

- 使用问题或功能建议：[GitHub Issues](https://github.com/bigzhihui/bentopdf/issues)。
- 私密问题或安全报告：[support@afeiii.com](mailto:support@afeiii.com)。请勿在公开 Issue 中上传含个人信息的原始 PDF、密钥或令牌。
- 提交代码前请阅读[贡献说明](CONTRIBUTING.md)；安全报告见[安全政策](SECURITY.md)。

## 致谢与许可证

本项目基于 [alam00000/BentoPDF](https://github.com/alam00000/bentopdf)，感谢原作者和所有贡献者。原始作者、第三方组件的署名和许可证保留。

本站定制源码按 [GNU AGPL-3.0](LICENSE) 公开。上游商业授权信息请直接向原项目确认；本仓库不销售或代售上游商业许可。
