# 公网 Node.js / HTTPS 部署

项目已包含 `render.yaml`，用于单实例 Render Node.js 服务及1GB持久磁盘。此文件是可审阅的部署配置，不代表已经创建服务或取得公网地址。Render 托管与持久磁盘通常收费，以平台创建前显示的报价为准。

## 使用 Render

1. 注册或登录 Render，在工作区创建 Blueprint，连接 GitHub 的 `Imraymondo/TennisCourtBooking` 仓库与 `main` 分支，读取仓库中的 `render.yaml`。
2. 检查配置：Node24.22.1、单实例、持久磁盘 `/var/data`、SQLite路径 `/var/data/bookings.sqlite`、健康检查 `/api/health`。确认平台显示的费用后创建。
3. Render 自动生成高强度 `ADMIN_PASSWORD`。在服务的安全环境变量页面查看并保存该密码，供 `/admin` 登录使用；它不会写入仓库或构建日志。
4. 首次构建和健康检查通过后，在服务页面复制平台实际分配的 HTTPS 地址。无需购买域名。启动器自动将 `RENDER_EXTERNAL_URL` 作为 `APP_BASE_URL`。
5. 访问英语公开首页与英语工作人员后台，并检查 `/api/health`。健康状态应为 `{"status":"ok","service":"courtside"}`。登录后台，验证测试预约的创建、修改和取消，然后重启服务验证数据仍在。

Blueprint入口：[从此仓库准备Render部署](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FImraymondo%2FTennisCourtBooking)。这是部署配置入口，不是已经上线的网站。

## 电话接入

在部署服务的安全环境变量中设置已有 `TWILIO_AUTH_TOKEN` 和 `TWILIO_PHONE_NUMBER`。本开发环境中的值不会自动复制到部署平台。使用原来的密钥即可，无需在聊天中提供。

在 Twilio 号码的 Voice 配置中，将收到电话时的 POST webhook 指向部署站点的 `/api/webhooks/voice`。语音助手用英语处理预约相关问题，Gather识别使用 `en-AU`，播报使用 `Polly.Olivia-Neural`；通过语音识别收集日期、时间、时长、姓名和联系电话，由程序分配球场，播报数据库中的真实空档，并在客户明确确认后写入预约。姓名公开展示，联系电话只在受保护的管理界面显示。

可用英语说“I’d like to book tomorrow at 3 pm.”，核对完整复述后，在下一轮说“confirm booking”或按1。Realtime输入转写也使用英语 `en`，本机音频桥配置见[Realtime电话接入](realtime-phone.md)。

Twilio 回调认证需要精确的站点 origin。以后启用自定义域名时，将 `APP_BASE_URL` 显式设为该 HTTPS origin，并相应修改 Twilio webhook，避免签名校验失败。

## 其他 Node.js 平台

运行环境需要Node24.5+（24.x），长期运行的单实例进程，以及持久可写磁盘。构建命令：

```bash
npm ci --include=dev --no-fund
npm run check
npm test
npm run build
```

安全配置以下运行变量：

- `ADMIN_PASSWORD`：12–256位唯一密码。
- `BOOKING_DB_PATH`：已挂载持久磁盘中的绝对文件路径。
- `APP_BASE_URL`：实际公网HTTPS origin，不能包含路径、账号、查询参数或fragment。
- `PORT`：平台分配的监听端口，未设置时为3000。

启动命令 `npm start`。平台负责HTTPS证书与反向代理，应用监听 `0.0.0.0`。不满足密码、磁盘路径或HTTPS origin要求时，启动器会直接报配置错误，不会把不完整设置的服务标成已就绪。

## 验证范围

`npm run test:integration` 使用隔离数据库检查API和生产启动器，包括按平台PORT启动、HTTPS origin识别、SIGTERM退出、服务重启后的预约持久化、隐私和工作人员登录。测试不会向真实客户拨号或发送短信、邮件。

取得公网地址后仍须做实际HTTPS可达性和Twilio来电验证。未配置托管账号或部署授权时，不能仅凭本地构建成功就宣布网站已上线。
