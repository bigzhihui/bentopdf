# 参与十三月 PDF 工具

本仓库维护 [pdf.afeiii.com](https://pdf.afeiii.com) 的中文品牌和 Cloudflare Pages 部署，基于 [BentoPDF](https://github.com/alam00000/bentopdf)。

## 问题反馈

请在本仓库 [Issues](https://github.com/bigzhihui/bentopdf/issues) 选择故障、功能建议或使用问题模板。尽量说明工具名称、复现步骤、浏览器及系统版本。示例文件应先脱敏；不能公开文件时，可以描述构造方法。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 提交修改

1. 从最新 `main` 创建分支，保持改动范围明确。
2. 保留文件原有换行、上游署名和许可证；密钥不进仓库。
3. 按 README 执行相关类型检查、测试及构建。
4. PR 写清问题、改法、实际执行的验证和未验证部分。

影响 PDF 处理、字体、WASM、OCR 或查看器的改动，需要使用已脱敏的真实文件验收下载结果。只改文档时无需编写重复实现内容的测试。

## 上游同步

自动更新 PR 是待审候选。合并前检查中文品牌、内容页、资源路径、13 个 Office 转 PDF 禁用项、安全头和 Cloudflare 构建。冲突应在更新分支处理，不用强制同步覆盖本站提交。

本定制仓库不要求贡献者另签上游 CLA。仓库中的 ICLA、CCLA 和签名记录属于上游历史材料；若将改动另行贡献给上游，应遵循上游当时的贡献要求。
