# 钉钉云盘（钉盘）API 接入调研

> 调研日期：2026-05-24

## 结论

**钉钉云盘（钉盘）完全支持 API 接入。** 钉钉开放平台提供了完整的服务端 API，涵盖文件上传、下载、预览、权限管理等功能。

## 核心能力

| 功能 | 说明 |
|------|------|
| 文件上传 | 通过 OSS 加签方式上传，支持分步提交 |
| 文件下载 | 获取临时下载链接 |
| 文件预览 | 在线预览钉盘文件 |
| 文件管理 | 查询文件/文件夹列表、获取文件详情 |
| 权限管理 | 添加/查询用户对空间和文件的访问权限 |
| 共享空间 | 支持企业共享空间的文件操作 |

## 接入步骤

1. 在钉钉开放平台创建企业内部应用
2. 申请钉盘相关接口权限
3. 获取 access_token 凭证
4. 调用服务端 API

## 关键接口文档

| 文档 | 链接 | 说明 |
|------|------|------|
| 云盘概述 | https://open.dingtalk.com/document/development/ding-drive-overview | 官方总览，2026-05-15 最新更新 |
| 钉盘文件上传/预览/下载指南 | https://open.dingtalk.com/document/development/dingpan-document | 完整接入流程 |
| 提交文件 | https://open.dingtalk.com/document/development/submittal-file | 文件上传具体步骤（含 Java 示例） |
| 获取文件或文件夹信息 | https://open.dingtalk.com/document/development/obtain-file-or-folder-information | 文件详情查询 |
| API 总览 | https://open.dingtalk.com/document/isvapp/api-overview | 所有接口权限列表 |
| 钉盘共享空间上传及下载 | https://open.dingtalk.com/document/orgapp/upload-and-download-dingtalk-files | 共享空间文件操作流程 |

## 注意事项

- 钉盘已升级为「存储产品」，旧版接口已迁移至历史文档，建议使用新版接口
- 文件上传采用阿里云 OSS header 加签方式，非直接上传
- 支持三种接入模式：企业内部应用、第三方企业应用、第三方个人应用
- 权限管理支持：获取权限列表、添加权限、授权审批下载
- 文件上传分两步：先获取上传凭证，再通过 OSS 加签上传

## 调研过程

1. 搜索「钉钉云盘 API 接入 开发文档」，找到钉钉开放平台官方文档入口
2. 搜索「DingTalk drive cloud storage API integration」，确认国际版文档和 SDK 支持
3. 搜索「钉钉开放平台 云盘 API 文件上传 下载 权限 接口列表」，获取具体接口清单
4. 抓取云盘概述页面和文件上传指南页面，确认文档内容完整性
