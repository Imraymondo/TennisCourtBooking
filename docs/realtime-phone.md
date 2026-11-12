# OpenAI Realtime直接接听和回复电话

`VOICE_MODE=realtime` 让GPT直接接收电话音频并生成语音回复。Twilio接听真实来电，通过双向Media Stream连接本机音频桥，再与OpenAI Realtime交换音频。预约流程、身份核验、明确确认、时段冲突检查和SQLite写入仍由本机程序控制。它与 `BOOKING_AI_ENABLED` 的Responses API文本理解是两项独立设置。

网站和预约数据库继续运行在自己的电脑，不需要部署服务器、购买域名或公开首页与后台。ngrok的HTTPS隧道同时支持音频WebSocket；公网只允许电话回调、认证后的音频流，以及使用 `sms:local` 时的短信回调。内部预约API不会通过隧道公开。电脑、网络、终端和隧道必须持续运行。

## 1. 准备账号和本机配置

保留已有 `.env.local` 和 `.data`，不要覆盖文件或删除预约。首次配置Twilio号码和ngrok时，先按[本机电话接入](local-phone.md)准备支持Voice的号码、`TWILIO_AUTH_TOKEN`、`TWILIO_PHONE_NUMBER` 与 `NGROK_AUTHTOKEN`。需要Node.js 24.5以上的24.x版本，推荐 `.nvmrc` 中的24.22.1。

若尚无OpenAI API账号：

1. 在[OpenAI开发者平台](https://platform.openai.com)注册或登录，创建或选择自己的API项目。
2. 在Billing页面开通API计费，按平台要求添加支付方式或余额。ChatGPT订阅与API分别计费。
3. 在项目的[API keys](https://platform.openai.com/api-keys)中创建服务端API key；受限密钥需要允许Realtime及所选输入转写服务。模型是否可用以自己项目的权限和实际请求结果为准。
4. 在Usage、Limits和Billing中查看额度、费用和预算提醒。提醒是否属于硬性限额，以账号当前提供的控制为准。

只在自己电脑的项目根目录 `.env.local` 补充：

```dotenv
VOICE_MODE=realtime
OPENAI_API_KEY=这里填写自己的项目API密钥
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-transcribe
```

密钥只供服务器使用，不加 `NEXT_PUBLIC_` 前缀，不填入网页、Twilio回调URL、Git或聊天。本地脚本每次启动自动生成内部音频桥认证密钥，不需要填写 `REALTIME_BRIDGE_SECRET`。

`VOICE_MODE` 只接受 `gather` 或 `realtime`，未设置时继续使用原来的 `gather`。Realtime即使在 `BOOKING_AI_ENABLED=0` 时也需要OpenAI API key。短信可独立用 `BOOKING_AI_ENABLED=1` 启用自然语言理解，`OPENAI_MODEL` 保持Responses API文本模型，例如 `gpt-4.1-mini`；不要把Realtime模型填入该变量。

当前Realtime默认模型为 `gpt-realtime-1.5`，输入转写为 `gpt-transcribe`，转写语言为中文 `zh`。可按账号权限更改各自模型变量；配置通过不代表模型有权限。内置声音可选 `alloy`、`ash`、`ballad`、`coral`、`echo`、`sage`、`shimmer`、`verse`、`marin`、`cedar`，默认 `marin`。

电话预约成功后如需确认短信，在现有 `.env.local` 额外填写Twilio控制台中的 `TWILIO_ACCOUNT_SID`（`AC` 后接32位十六进制字符），复用已有 `TWILIO_AUTH_TOKEN` 和支持SMS的 `TWILIO_PHONE_NUMBER`。不要发送SID或密钥到聊天中。缺少SID或格式不正确时，原电话流程仍可使用，成功后编号和管理码各读一次。

## 2. 预检并启动

在旧服务终端按 **Ctrl+C**，在原项目目录执行：

```bash
git pull
npm ci --include=dev
npm run phone:check
npm run realtime:check
npm run phone:local
```

预检应显示：

```text
Voice mode: OpenAI Realtime (model gpt-realtime-1.5)
```

`phone:check` 只检查配置存在性和安全格式，不联网、不打开隧道、不消耗OpenAI额度，也不验证密钥、账单、模型访问权限或真实通话。`npm run ai:check` 只检查可选Responses API文本理解，不能用它的成功结果代替Realtime音频测试。

`npm run realtime:check` 会连接OpenAI并检查实际Realtime音频会话配置，成功显示 `Realtime API check passed`。此检查可能使用API额度，不发送来电音频、不写预约；它验证模型和会话连接，真实电话的声音、打断和预约流程仍需下一节的手机验收。

启动脚本建立仅限回调与音频流的隧道，自动设置当前 `APP_BASE_URL`，启动本机Next.js网站与音频桥。终端会输出本机网站、**Twilio Voice webhook (POST)** 和 **Realtime audio stream**。本机网页默认在3000端口；无需手工修改 `.env.local` 的 `APP_BASE_URL`。

需要同时接收短信时，改用 `npm run sms:local`；不要同时运行两份服务。`phone:diagnose` 可开启只含元数据的诊断。

已有电话配置升级确认短信时，保留 `VOICE_MODE=realtime`、`.env.local` 和 `.data`，在旧服务按 **Ctrl+C** 后执行 `git pull`、`npm run phone:check`、`npm run sms:local`。本次没有新增依赖；依赖更新时可先运行 `npm ci --include=dev`。预检显示 `Phone booking SMS: configured` 或包含变量名的 `not configured`，不显示SID值，也不联网验证短信账号。数据库会自动创建短信发送记录表，无需重置。只发送出站确认短信无需Messaging回调，也可继续用 `phone:local`。

## 3. 配置Twilio

在Twilio号码的 **Voice → A CALL COMES IN → Webhook** 填入本次终端实际输出的：

```text
https://你的隧道域名/api/webhooks/voice
```

方法为 **HTTP POST**。该地址仍是来电入口；不要把终端的 `wss://…/api/realtime/voice` 填入Voice URL。系统会在已认证的来电响应中连接音频流。隧道域名变化后更新Voice URL；启用短信时也更新Messaging POST URL。

浏览器直接打开回调或WebSocket被拒绝属于预期行为。系统保留Twilio签名校验，不需要给隧道添加网站登录页。生产 `npm start` 和单独 `npm run dev` 不会启动这个本机音频桥，应使用本页的 `phone:local` 或 `sms:local`。

## 4. 用真实手机验收

先打开本机网站核对未来日期的空档，再用正常显示号码的手机拨打Twilio号码。试用账户的验证号码和地区权限按Twilio控制台要求处理。电话中的时间统一按 **Australia/Sydney** 解释。

- 查询：“明天下午三点二号球场能预约两小时吗？”核对回复与网页空档。
- 创建：助手以简短自然的普通话逐项询问，以日常说法播报日期和时间，不念标点、不逐字停顿或重复提示。按提示补齐日期、球场、时间、时长、姓名和联系方式，核对完整复述，再在下一轮明确说“确认预约”或按1。姓名会在日程公开显示，测试时使用适合公开的姓名。
- 验证未确认、否定、字段缺失、无关问题与已占用时段不会创建预约。不要在最初需求中夹带确认。
- 成功后查看发到已确认联系电话的短信，核对日期、场地、时间、时长、姓名、预约编号和管理码；未配置或发送失败时，系统将编号和管理码各读一次供记录。刷新本机网页核对；测试查询、修改和取消，并确认取消后时段释放。修改与取消仍须凭据核验和单独确认。
- 在系统提示输入数字时，可用电话键盘输入预约编号、管理码等内容。不要把密钥或无关个人信息说进电话。

还应试验说话打断、短暂静音及挂断后的重新拨号。若出现断音、迟迟没有回复或模型权限错误，核对OpenAI项目Usage、Billing、模型权限与Twilio通话/Media Stream错误码。可提供大致通话时间和脱敏错误码；不要提供音频、完整转写、客户电话或管理码。

确认短信在客户明确确认、预约成功写入后才通过Twilio REST API提交。提交失败也保留预约；Twilio接受请求不保证短信已送达。重复电话回调不会重复发送，网络状态不明时不会盲目重发，也没有后台自动重试循环。试用账号须按Twilio要求验证接收号码；管理码可修改或取消预约，请客户私下保存短信。

仓库自动化测试使用模拟OpenAI和Twilio事件，验证受控预约流程、签名与内部认证、音频转发和中断处理，不发送真实短信。本次没有用你的真实账号、号码或手机验证通话和短信送达，必须完成上述本机验收后再给客户使用。

### 说“我要预定”却没有进入预约时

先更新代码并停止旧服务，再运行 `npm run sms:local -- --diagnose`（只需要电话时可用 `npm run phone:diagnose`）。新版兼容分开到达的Realtime函数事件；某轮没有有效函数结果时，将原始语音转写交给预约程序继续处理。“我要预定”应进入日期追问，之后可以回答“明天”，逐项补齐信息。

终端会输出不含原话的状态，例如：

```text
Realtime turn: {"version":"realtime-routing-2","input":"speech","speechLength":4,"stepBefore":"menu","stepAfter":"date","handling":"fallback_missing_function"}
```

`handling=function` 表示使用模型字段；`fallback_missing_function` 或 `fallback_invalid_fields` 表示使用原始转写处理，仍会进行身份、确认和数据库检查。`stepBefore=menu`、`stepAfter=date` 表示已经进入预约日期步骤。若仍有问题，可提供这两三行状态和错误码；不要发送密钥、音频、完整转写、客户资料或管理码。

## 数据范围与费用

Realtime模式会把**通话音频直接发送给OpenAI**，其中可能包含姓名、联系方式、预约编号、管理码及其他来电者说出的内容。输入音频还会交给配置的转写模型处理。服务器控制预约结果，不等于敏感内容只留在本机；Gather文本模式中“收集联系方式时不调用模型”的范围不适用于Realtime。

使用键盘输入可避免将对应数字说进音频，但预约办理和语音复述仍可能涉及个人信息，不应据此承诺完整隔离。应用日志仅记录连接、步骤、输入状态等元数据，不打印通话音频、转写全文、联系电话、管理码、API key或服务商错误正文。

Realtime音频、输入转写会使用OpenAI API额度；Twilio号码、通话与Media Streams及ngrok分别按各自账号计费。请查看服务商当前价格和数据政策。Responses API的 `store:false` 是文本理解请求设置，不能套用为Realtime零留存承诺；数据处理、滥用监测和可用控制以OpenAI当前政策及项目设置为准。

## 切回原来的电话模式

将 `.env.local` 的 `VOICE_MODE=gather`，按 **Ctrl+C** 停止旧服务，再运行原来的 `phone:local` 或 `sms:local`。预检应显示 `Voice mode: Twilio Gather`。`BOOKING_AI_ENABLED=0` 可同时关闭Gather与短信的可选文本理解；仅关闭该开关不会关闭Realtime音频。数据库和已有预约保留，隧道域名变化时更新Twilio回调。
