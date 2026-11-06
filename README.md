# COURTSIDE · 网球场预约

基于 Next.js App Router、React、TypeScript 和 npm 的预约产品起点。界面使用本地 CSS/SVG，不依赖外部字体、图片服务、数据库或 API 密钥。

## 开发

推荐 Node.js **24.22.1**（见 `.nvmrc`）与 npm **11.9.0**。

```bash
cd /workspace/TennisCourtBooking
npm ci
npm run dev
```

开发服务监听 `0.0.0.0:3000`；文件保存后自动更新。端口被占用时使用 `npm run dev -- --port 3001`。

在自己的电脑运行时，可通过浏览器打开本机的 3000 端口查看页面。云环境的 onboarding 界面不提供 localhost 网页预览；服务启动和功能会通过环境内 HTTP 请求及浏览器检查验证，不生成公共预览链接。后续可将仓库克隆到本地运行，或部署到支持 Next.js 的托管平台。

## 命令

| 命令                | 用途                                        |
| ------------------- | ------------------------------------------- |
| `npm ci`            | 按 `package-lock.json` 精确安装依赖         |
| `npm run dev`       | 启动开发服务，默认 3000 端口                |
| `npm run lint`      | ESLint 检查，警告也会失败                   |
| `npm run typecheck` | 生成 Next.js 路由类型并运行 TypeScript 检查 |
| `npm run check`     | 运行 Lint 与类型检查                        |
| `npm run build`     | 创建生产构建                                |
| `npm start`         | 启动已构建的生产服务                        |

生产运行需要先执行 `npm run build`。可使用 `npm start -- --port 3001` 单独验证生产服务，避免与开发服务冲突。

## 功能边界

首页是可交互的前端演示，包含场地列表、日期和场地筛选、时段选择及预约确认。场地、价格和可用时段为示例数据；确认不会创建真实预约、收费或持久保存数据。后续可接入身份认证、数据库、库存校验和支付流程。

## 云环境复用

环境配置中保存的安装步骤在当前仓库运行 `npm ci`、`npm run check` 和 `npm run build`。启动说明负责在新任务中重新启动开发服务并检查响应。已安装依赖和构建输出可以保留，但运行中的服务不会随环境快照恢复。

每个云任务已有隔离环境，应复用现有检出目录，无需创建 Git worktree。不要将 `.env`、依赖目录或构建产物提交到 Git。

当前 Next.js ESLint 预设的部分插件尚未声明支持 ESLint 10，因此固定使用兼容的 ESLint 9；升级时需同时确认插件兼容性。
