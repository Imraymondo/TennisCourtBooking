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

### 让GPT直接听电话和说话：OpenAI Realtime

在已有本机Twilio和ngrok配置中添加以下服务端设置。默认仍为 `VOICE_MODE=gather`；选择 `realtime` 后，Twilio通过双向音频流把电话音频交给OpenAI Realtime，GPT生成语音回复，预约规则和写入仍由本机程序与同一个SQLite数据库控制。

```dotenv
VOICE_MODE=realtime
OPENAI_API_KEY=这里填写自己的OpenAI项目API密钥
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-transcribe
```

先开通[OpenAI API账号与独立计费](https://platform.openai.com)，在自己电脑已有的 `.env.local` 中填写密钥，然后停止旧服务，运行 `npm ci --include=dev`、`npm run phone:check` 和 `npm run phone:local`。Twilio的Voice URL仍使用终端输出的 **HTTPS POST `/api/webhooks/voice`**，音频WebSocket由系统自动连接。无需公开网站或后台，也不需要部署到云服务器。

Realtime不依赖 `BOOKING_AI_ENABLED`；该开关继续控制短信和Gather模式的可选文本理解。`OPENAI_MODEL` 继续使用Responses API文本模型，不能填Realtime模型。Realtime会把通话音频发送给OpenAI，其中可能包含姓名、电话、预约编号或管理码；API音频、输入转写与Twilio通话分别计费。预检和模拟测试不能证明真实电话已接通。完整账号设置、手机验收、隐私说明和切回方法见[Realtime电话接入](docs/realtime-phone.md)。

### 电话预约成功后发送确认短信

在自己电脑现有的 `.env.local` 中补充Twilio控制台中的 `TWILIO_ACCOUNT_SID`（`AC` 后接32位十六进制字符），复用已有的 `TWILIO_AUTH_TOKEN` 和 `TWILIO_PHONE_NUMBER`。号码须支持SMS，试用账号还需按控制台要求验证接收号码。不要把这些值发到聊天或提交Git。

先按 **Ctrl+C** 停止旧服务，再执行 `git pull`、`npm run phone:check` 和 `npm run sms:local`；此次更改没有新增依赖，依赖有更新时再运行 `npm ci --include=dev`。保留已有 `VOICE_MODE`、`.env.local` 和 `.data`，数据库会自动增加短信发送记录表，无需重置。预检仅显示 `Phone booking SMS: configured` 或包含变量名的 `not configured` 状态，不显示SID值，也不联网验证账号。

客户明确确认并成功创建电话预约后，系统通过Twilio REST API向已确认的联系电话发送日期、场地、时间、时长、姓名、预约编号和管理码。仅发送这类出站确认短信也可继续用 `phone:local`；`sms:local` 额外支持接收客户短信。未配置或SID格式不正确时，电话预约仍可办理，成功后将编号和管理码各读一次。短信提交失败也保留预约并提示客户记录凭据；Twilio接受请求不代表短信已送达。重复电话回调不会重复发送，网络状态不明时不盲目重发，也没有后台自动重试循环。管理码可用于修改或取消预约，请客户私下保存。自动化测试使用模拟服务，不发送真实短信。

### 本机同时接收电话和短信

需要短信时，在原服务的终端按 **Ctrl+C** 停止，再更新代码并启动：

```bash
git pull
npm run sms:local
```

`sms:local` 使用同一个本机网站和SQLite数据库，同时转发经过认证的Voice与Messaging回调；`phone:local` 默认仍只转发Voice。首页、`/admin` 和邮件接口均不通过隧道公开，不需要删除或重新填写已有 `.env.local`，也不要删除 `.data`。

启动后，将实际输出的 **Twilio Messaging webhook (POST)** 地址填入号码的 **Messaging → A message comes in → Webhook → HTTP POST**。已设置过短信回调，也要与本次启动输出的最新地址核对；隧道域名变化时，Voice回调也需同步更新。号码必须支持SMS，试用账号按Twilio控制台要求验证测试号码。

手机先发送“帮助”，再查询未来日期、预订、修改和取消；本机网页会显示同一份日程。默认使用固定短信指令；可按下节配置GPT理解预约自然语言。完整步骤、指令示例及无回复排查见[本机真实短信接入与测试](docs/local-sms.md)。自动化测试只模拟短信回调，尚不能证明真实手机短信已接通。

### 可选：让Gather电话和短信使用GPT理解预约文本

默认 `BOOKING_AI_ENABLED=0`。这一文本理解功能从Gather电话语音转写或短信中提取预约意图与字段，程序继续查询同一个SQLite数据库，并在自然语言预约、修改或取消写入前向客户复述，等待下一轮明确确认。`VOICE_MODE=gather` 时由Twilio识别语音和播报；直接使用OpenAI音频应按上节启用Realtime。原有固定短信及邮件指令继续可用，邮件本次不接入GPT。

如果尚无OpenAI API账号，先到 [OpenAI开发者平台](https://platform.openai.com) 注册，开通**独立于ChatGPT订阅的API计费**，再在项目中[创建API key](https://platform.openai.com/api-keys)。仅在自己电脑现有的 `.env.local` 中补充：

```dotenv
BOOKING_AI_ENABLED=1
OPENAI_API_KEY=这里填写自己的项目API密钥
OPENAI_MODEL=gpt-4.1-mini
```

在旧服务终端按 **Ctrl+C**，执行 `git pull`、`npm run phone:check`，再用 `npm run sms:local` 同时接收电话与短信，或 `npm run phone:local` 只接收电话。隧道域名变化时，更新Twilio中对应的Voice与Messaging回调。`phone:check` 只检查配置，显示所选模式和模型，不连接OpenAI验证密钥或账号。

默认模型为兼容当前接口而选，并非承诺最新或每个账号都可用；可通过 `OPENAI_MODEL` 更换支持Responses API严格JSON Schema文本输出的模型。OpenAI API和Twilio分别计费。启用后，预约文本或语音转写及有限上下文会发送给OpenAI；请求设置 `store:false`，这不代表零留存。密钥只供服务器使用，不要添加 `NEXT_PUBLIC_` 前缀、提交Git或发到聊天中。账号开通、费用控制、数据范围、测试和回退方法见[GPT预约接入步骤](docs/openai-booking.md)。

### 工作人员密码

开发模式首次访问后台时，在 `.data/admin-password` 自动生成随机密码。请在自己的终端查看该本地文件登录，不要提交或分享。也可在未跟踪的 `.env.local` 中设置至少12位的 `ADMIN_PASSWORD`。

生产模式必须配置 `ADMIN_PASSWORD`，否则后台登录关闭。登录使用HttpOnly Cookie，8小时过期；密码轮换会使旧会话失效。不要将密码或密钥发到聊天中。

### 数据持久化

默认数据库 `.data/bookings.sqlite`，可用 `BOOKING_DB_PATH` 指定绝对路径。`.data/`、`.env.local` 和构建输出不提交到Git。刷新或重启服务不会丢失预约。

生产部署使用一个持续运行的Node服务和**持久可写磁盘**。不要把SQLite放在无持久磁盘的serverless实例上，也不要让多个独立磁盘上的实例处理同一套预约。备份使用SQLite备份机制，或停止写入后保存数据库及其WAL文件。

## 命令与验证

| 命令                       | 用途                                          |
| -------------------------- | --------------------------------------------- |
| `npm ci`                   | 按锁文件安装                                  |
| `npm run dev`              | 开发服务                                      |
| `npm run phone:check`      | 检查本机电话配置，不联网、不显示凭据值        |
| `npm run phone:local`      | 启动本机网站和仅转发电话回调的临时隧道        |
| `npm run sms:local`        | 启动同一本机网站，转发电话和短信回调          |
| `npm run ai:check`         | 检查Responses API文本理解；不验证Realtime音频 |
| `npm run realtime:check`   | 检查Realtime音频会话连接，不创建预约          |
| `npm run phone:diagnose`   | 启动电话服务并输出不含语音原文的诊断状态      |
| `npm run check`            | ESLint与TypeScript                            |
| `npm test`                 | 业务、时区、并发、持久化和渠道测试            |
| `npm run build`            | 生产构建                                      |
| `npm run test:integration` | 构建后启动隔离生产服务，验证真实HTTP API      |
| `npm start`                | 生产服务                                      |

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

如果网站只在自己的电脑运行，请使用[本机短信接入步骤](docs/local-sms.md)中的 `npm run sms:local`；仅运行 `phone:local` 时，短信回调不会通过临时隧道。

系统校验Twilio签名及接收号码，重试相同事件时复用结果。`TWILIO_AUTH_TOKEN` 用于本地签名校验，必须直接提供给应用，不能使用仅在出站代理替换的占位符。

电话默认使用Twilio语音识别和预约专用状态机，不需要额外语言模型账号；可选[Gather文本理解](docs/openai-booking.md)或[OpenAI Realtime直接音频](docs/realtime-phone.md)。客户可以直接说“我要预约明天下午三点”。助手用简短自然的普通话先确定日期和开始时间，再补齐时长（1–8小时，默认2小时）、姓名和联系电话；日期和时间按日常说法播报，不念标点、不逐字停顿或重复提示。使用来电号码也必须由客户明确选择。

Gather与Realtime电话预约都由程序分配球场，不询问或采用客户、模型的球场偏好：优先选择整个预约时段都有空的一号场，再检查二号场；不会把一次预约拆到两个场地。两场都不可用时请客户换时间。写入前会复述包括已分配球场在内的完整信息，仅在客户下一轮说“确认预约”或按1后提交。确认时若出现冲突，程序重新检查分配；分配有变化须重新复述并再次确认，不会悄悄换场写入。无关问题、含糊确认、否定和信息缺失不会创建预约。短信指令的场地选择方式保持不变。

客户也可用语音查询、修改、取消预约，并保留按键输入方式。配置电话确认短信后请客户查看短信；无法提交短信时会读出编号与管理码各一次，请客户记录。成功后网站日程接口立即更新，已经打开的页面会在自动刷新时显示。

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
