# COURTSIDE · 网球场预约系统

Next.js + TypeScript + React + SQLite。两个场地每天24小时开放，默认预约 **2小时**，可选择1–8个整小时。日历、通知和电话提示统一使用 **Australia/Sydney** 时区。

## 功能

- 公开网页按日期展示两个场地的预约、预约人姓名与可用整点；电话、邮箱和管理码不公开。
- 日程每格表示1小时的实际占用。连续空闲不足所选时长时仍显示空闲，并标注可用时长；例如8–10点已有预约，7–8点仍可单独预约1小时。
- 客户可以创建预约，并凭预约编号及管理码查询、修改和取消自己的预约。
- `/admin` 工作人员后台登录后显示完整联系信息、来源和状态，支持代客创建、修改和取消。
- Twilio短信、预约专用中文语音助手，以及Postmark邮件指令共用同一份预约数据。
- SQLite事务防止同场地重复预约；版本检查防止并发修改覆盖；取消保留记录并释放时段。
- 支持跨午夜。时长按实际经过小时计算；夏令时不存在或重复的本地整点标记不可选，避免猜测时间。

## 本地开发

需要 **Node.js 24.5–24.x**，推荐 `.nvmrc` 中的 **24.22.1**，npm **11.9.0**。

```bash
npm ci
npm run dev
```

服务监听 `0.0.0.0:3000`。本地浏览器打开本机3000端口，工作人员入口为 `/admin`。云onboarding界面不提供localhost网页预览，可使用环境内HTTP/浏览器检查及截图；公网访问需要另行部署。

未配置外部服务时，网页预约功能仍可完整使用，电话、短信和邮件显示待配置；接口不会绕过认证。

### 不部署网站，直接用自己的电脑接听电话

支持本机网站和数据库配合临时HTTPS隧道，只转发Twilio电话回调，首页和后台不通过隧道公开。填好本机 `.env.local` 中已有的 `TWILIO_AUTH_TOKEN`、`TWILIO_PHONE_NUMBER`，再添加自己的 `NGROK_AUTHTOKEN`：

```bash
npm ci --include=dev
npm run phone:check
npm run phone:local
```

将命令实际输出的VoiceWebhook地址填入Twilio号码的来电配置，选择POST，再拨打该号码。无需Render账号或购买域名；保持电脑和终端运行。详见[本机真实电话接入步骤](docs/local-phone.md)。

### 工作人员密码

开发模式首次访问后台时，在 `.data/admin-password` 自动生成随机密码。请在自己的终端查看该本地文件登录，不要提交或分享。也可在未跟踪的 `.env.local` 中设置至少12位的 `ADMIN_PASSWORD`。

生产模式必须配置 `ADMIN_PASSWORD`，否则后台登录关闭。登录使用HttpOnly Cookie，8小时过期；密码轮换会使旧会话失效。不要将密码或密钥发到聊天中。

### 数据持久化

默认数据库 `.data/bookings.sqlite`，可用 `BOOKING_DB_PATH` 指定绝对路径。`.data/`、`.env.local` 和构建输出不提交到Git。刷新或重启服务不会丢失预约。

生产部署使用一个持续运行的Node服务和**持久可写磁盘**。不要把SQLite放在无持久磁盘的serverless实例上，也不要让多个独立磁盘上的实例处理同一套预约。备份使用SQLite备份机制，或停止写入后保存数据库及其WAL文件。

## 命令与验证

| 命令                       | 用途                                     |
| -------------------------- | ---------------------------------------- |
| `npm ci`                   | 按锁文件安装                             |
| `npm run dev`              | 开发服务                                 |
| `npm run phone:check`      | 检查本机电话配置，不联网、不显示凭据值   |
| `npm run phone:local`      | 启动本机网站和仅转发电话回调的临时隧道   |
| `npm run phone:diagnose`   | 启动电话服务并输出不含语音原文的诊断状态 |
| `npm run check`            | ESLint与TypeScript                       |
| `npm test`                 | 业务、时区、并发、持久化和渠道测试       |
| `npm run build`            | 生产构建                                 |
| `npm run test:integration` | 构建后启动隔离生产服务，验证真实HTTP API |
| `npm start`                | 生产服务                                 |

```bash
npm run check
npm test
npm run build
npm run test:integration
npm start
```

测试使用临时数据库，不发送真实电话、短信或邮件。更改端口可使用 `npm run dev -- --port 3001` 或 `npm start -- --port 3001`。生产启动还必须设置 `ADMIN_PASSWORD`、持久磁盘中的绝对 `BOOKING_DB_PATH`，以及公网 HTTPS 的 `APP_BASE_URL`（Render可自动取 `RENDER_EXTERNAL_URL`）。完整配置见[公网部署说明](docs/deployment.md)和 `render.yaml`。

## 电话、短信和邮件接入

接口可自动查询、创建、修改和取消预约。**真实收发需要服务商账号、可用号码、邮件服务及公网HTTPS地址；代码测试通过不等于真实渠道已开通。** 不必购买域名，可以使用支持持久磁盘的部署平台提供的HTTPS域名。

配置项见 [`.env.example`](.env.example)。在部署平台或环境设置中安全填写，更新后重启服务，不要提交填写后的文件。

### Twilio电话和短信

1. 使用已有Twilio账号，准备支持Voice与SMS的号码。试用账号需遵守Twilio的号码验证限制。
2. 配置 `APP_BASE_URL` 为实际HTTPS origin（不含路径或尾部斜线）、`TWILIO_PHONE_NUMBER` 为E.164号码，以及 `TWILIO_AUTH_TOKEN`。
3. 在号码Messaging配置中，将收到短信的 **POST webhook** 设置为站点的 `/api/webhooks/sms`。
4. 在Voice配置中，将来电的 **POST webhook** 设置为站点的 `/api/webhooks/voice`。
5. 使用真实号码分别验证查询、创建、修改和取消后，再对外使用。

系统校验Twilio签名及接收号码，重试相同事件时复用结果。`TWILIO_AUTH_TOKEN` 用于本地签名校验，必须直接提供给应用，不能使用仅在出站代理替换的占位符。

电话使用 Twilio 语音识别和预约专用状态机，不需要额外语言模型账号，也不提供开放式闲聊。客户可以直接说“我要预约明天下午三点的二号球场”。系统读取数据库中的真实空档，逐步补齐日期、场地、时间、时长、姓名和联系电话；使用来电号码也必须由客户明确选择。写入前会复述完整信息，仅在客户说“确认预约”或按1后提交。无关问题、含糊确认、否定、信息缺失和时段冲突不会创建预约。客户也可用语音查询、修改、取消预约，并保留按键输入方式。预约编号与管理码会读出，请客户记录；成功后网站日程接口立即更新，已经打开的页面会在自动刷新时显示。

短信指令（日期为 `YYYY-MM-DD`，姓名不含空格，末尾时长省略时默认为2小时）：

```text
查询 日期 [场地号0/1/2] [时长]
预订 场地号 日期 HH:00 姓名 [时长]
查看 预约编号 管理码
修改 预约编号 管理码 场地号 日期 HH:00 [时长]
取消 预约编号 管理码
帮助
```

场地 `0` 表示查询全部。也支持 `QUERY`、`BOOK`、`VIEW`、`CHANGE`、`CANCEL`、`HELP`。创建成功会回复预约编号和管理码；查询返回可**开始**预约的整点。

### Postmark邮件

1. 配置Postmark入站邮箱及已验证发件地址。
2. 配置 `POSTMARK_SERVER_TOKEN`、`POSTMARK_FROM_EMAIL`、客户实际收件地址 `POSTMARK_INBOUND_EMAIL`，以及随机的 `POSTMARK_INBOUND_SECRET`。
3. 入站webhook为站点的 `/api/webhooks/email`，HTTP Basic Auth用户名固定为 `postmark`，密码为 `POSTMARK_INBOUND_SECRET`。
4. 客户向Postmark配置的入站邮箱发送与短信相同格式的指令（放在邮件标题，或正文第一行）；系统通过Postmark API自动回复发件人。

`POSTMARK_FROM_EMAIL` 是已验证发件地址，不一定等于客户发送到的入站邮箱，后者由Postmark配置决定，并用 `POSTMARK_INBOUND_EMAIL` 告知网页。`POSTMARK_INBOUND_SECRET` 必须直接提供给应用。出站 `POSTMARK_SERVER_TOKEN` 可以通过允许 `api.postmarkapp.com` 的HTTPS代理密钥绑定提供；Node24.5+原生HTTPS代理会保留环境代理与CA验证。

## 信息与权限

- 姓名按产品要求公开展示，创建表单会提示客户。可填写适合公开展示的姓名，勿在姓名中填电话。
- 预约编号不是凭据，客户必须同时提供随机管理码才可查看联系方式、修改或取消；请妥善保存管理码。
- 工作人员登录后可代办预约。接口有请求大小限制、限速、同源检查和渠道认证。
- 发生版本冲突时，重新查询最新预约并确认后再提交，系统不会静默覆盖。

## 云环境复用

每个云任务已隔离，复用 `/workspace/TennisCourtBooking`，不要额外创建Git worktree。安装脚本负责安装、检查、测试和构建；启动说明负责重新启动服务并检查首页与API。运行进程不会随快照恢复。真实业务库应放在部署服务的持久磁盘，不能把开发快照作为业务备份。

邮件回复在服务商已接收后发生进程中断的极端情况下可能重复投递；预约操作仍按入站事件幂等处理，不会重复创建预约。

当前Next.js ESLint插件要求ESLint9，升级时应同时检查插件兼容性。
