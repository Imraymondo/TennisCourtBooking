# 本机运行，接听真实电话

网站和SQLite数据库都在自己的电脑上运行，不需要Render、云服务器或自有域名。Twilio需要访问一个HTTPS回调，因此使用ngrok临时转发**电话接口**。公网端点不开放网站首页、后台或预约列表。

这是临时接入方式：电脑、预约服务与隧道必须持续运行。关闭终端、电脑休眠或网络断开后，电话无法继续办理预约；本地数据库仍会保留。

如需同时接收短信，请改用 `npm run sms:local`；它保留电话回调并额外允许短信回调，默认 `phone:local` 仍仅开放电话。Messaging配置、手机测试和故障排查见[本机短信接入与测试](local-sms.md)。

## 需要准备的信息

| 配置                  | 如何提供                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TWILIO_AUTH_TOKEN`   | 复用已有Twilio账号的Auth Token，填在自己电脑的 `.env.local`，不要发到聊天中                                              |
| `TWILIO_PHONE_NUMBER` | 已购买且支持Voice的Twilio号码，使用E.164格式，例如 `+61` 开头，不带空格                                                  |
| `TWILIO_ACCOUNT_SID`  | 工作人员外呼到场确认、电话预约确认短信时需要，取自Twilio控制台，格式为 `AC` 后接32位十六进制字符；确认短信还须号码支持SMS |
| `NGROK_AUTHTOKEN`     | 登录自己的ngrok账号，从[Authtoken页面](https://dashboard.ngrok.com/get-started/your-authtoken)获取，填在同一个本地文件中 |
| `NGROK_DOMAIN`        | 可选：ngrok账号分配的固定开发域名，只填主机名；不填写则由SDK请求可用地址                                                 |
| `PHONE_WEB_PORT`      | 可选，本机网页默认3000端口                                                                                               |

默认预约流程不需要额外语言模型账号。若希望用GPT理解更自然的预约表达，可按[OpenAI配置说明](openai-booking.md)添加API配置，继续使用同一份本机数据库和电话回调。Twilio和ngrok的套餐额度、语音和语音识别费用以各自账户为准。

## 1. 获取代码和安装

需要Node.js24.5以上的24.x版本，推荐24.22.1。下载或更新本仓库，在项目目录执行：

```bash
npm ci --include=dev
```

官方ngrokNodeSDK已包含在开发依赖中，无需单独安装ngrok命令行。

## 2. 在自己电脑填写配置

如果尚无 `.env.local`，复制 `.env.example` 并重命名为 `.env.local`。已有文件请直接补充缺失项，不要覆盖原来的配置。

填写以下三项的**真实值**，不要把下方说明文字当成密钥：

```dotenv
TWILIO_AUTH_TOKEN=这里填写你已有的TwilioAuthToken
TWILIO_PHONE_NUMBER=这里填写你的Twilio号码及国家代码
NGROK_AUTHTOKEN=这里填写你自己的ngrokAuthtoken
```

这些是应用和隧道在本地使用的原始凭据，不能用仅在出站代理中替换的占位符。`.env.local` 已被Git忽略，不要提交或分享。

如需工作人员外呼到场确认，或电话预约成功后发确认短信，在同一个文件中补充 `TWILIO_ACCOUNT_SID`，复用上面的Auth Token与Twilio号码。SID缺失或格式不正确时不阻止电话启动和来电预约，但不能提交外呼；预约成功后仍会将编号和管理码各读一次。不要将SID或密钥发到聊天中。

运行不会联网、不显示值的本地预检：

```bash
npm run phone:check
```

它只检查存在性与格式，不代表已经登录服务商或接通真实电话。出现Missing时，只需补齐所显示的变量名；可以把这份不含值的检查结果发给协助者。

确认短信的预检状态为 `Phone booking SMS: configured`，或包含 `TWILIO_ACCOUNT_SID` 变量名的 `not configured`；不显示SID值。已在使用旧版本时，先按 **Ctrl+C** 停止旧服务，再运行 `git pull`、`npm run phone:check` 和 `npm run sms:local`。本次更改无新增依赖；依赖更新时可先执行 `npm ci --include=dev`。已有 `VOICE_MODE` 配置会保留，`.env.local` 和 `.data` 无需重建，短信发送记录表会自动创建。仅需要电话和出站确认短信时，也可继续启动 `npm run phone:local`。

## 3. 一条命令启动

先停止本项目之前的 `npm run dev`，然后执行：

```bash
npm run phone:local
```

命令将：

1. 在本机回环地址建立只允许 `POST /api/webhooks/voice` 和 `POST /api/webhooks/attendance` 的电话代理；使用 `sms:local` 时另开放短信回调。
2. 建立临时ngrokHTTPS入口。
3. 在启动Next.js前，将这个入口自动作为 `APP_BASE_URL`，确保Twilio签名校验正确。
4. 启动本机网站并检查数据库健康。
5. 输出实际的 **Twilio Voice webhook (POST)** 地址。

无需手动填写或修改 `.env.local` 中的 `APP_BASE_URL`。脚本仅对子进程覆盖它，不改写本地文件；工作人员从本机后台发起外呼时，程序仍使用这个公网HTTPS地址生成回调。网站与数据库继续留在电脑上，网页默认通过本机3000端口访问。

终端须持续保持运行。Ctrl+C关闭隧道及这次启动的本地服务。若端口占用，请关闭旧服务，或在 `.env.local` 设置 `PHONE_WEB_PORT=3002`。不要终止其他应用。

## 4. 设置Twilio号码回调

打开Twilio控制台，进入 **Phone Numbers → Manage → Active numbers → 你的号码 → Voice配置**：

- **A CALL COMES IN**：选择 **Webhook**。
- URL：粘贴脚本刚输出的完整 `https://…/api/webhooks/voice` 地址。
- 请求方式：**HTTP POST**。
- 保存。

这不是通话状态回调，也不要把本机地址填进去。隧道地址若改变，需用新地址更新此设置。不要给此端点加浏览器登录页；系统已校验Twilio签名和接收号码。直接用浏览器打开电话接口会被拒绝，这是预期行为。

## 5. 用真实手机验证

用显示正常来电号码的手机拨打你的Twilio号码。试用账户如有验证号码或地区限制，先按Twilio控制台提示完成相应验证。

网页和电话均使用英语。Gather识别使用澳洲英语 `en-AU`，播报使用 `Polly.Olivia-Neural`；Realtime输入转写使用英语 `en`。可以说：“I’d like to book tomorrow at 3 pm.”。助手会用简短自然的英语先确定日期和开始时间，再收集时长（1–8小时，默认2小时）、姓名和联系电话，以日常说法播报日期和时间，不念标点、不逐字停顿或重复提示。

Gather和Realtime电话预约都不再询问球场，也不采用客户或模型提出的球场偏好。程序优先分配整个预约时段都有空的一号场，否则检查整个时段都有空的二号场；不会跨两个场地拼接空档，两场都不可用时请客户换时间。系统会完整复述包括分配球场在内的预约信息，只有客户在下一轮说“confirm booking”或按1之后才会写入。确认时如遇冲突会重新检查分配，球场有变化须重新复述并再次确认，不会静默换场提交。无关话题不会进入开放聊天，信息缺失、否定或含糊回答不会创建预约。短信指令仍按原有方式选择场地。

配置确认短信后，成功创建预约会通过Twilio REST API向客户已确认的联系电话发送日期、场地、时间、时长、姓名、预约编号与管理码。Twilio接受提交后请查看手机短信，这不等于保证送达。未配置或发送失败时，预约仍保留，系统会将编号和管理码各读一次供客户记录。重复回调不会重复发送；网络状态不明时不会盲目重发，也没有后台自动重试循环。试用账号请先按Twilio要求验证接收号码；管理码可用于修改或取消预约，不要公开短信或凭据。

打开本机网页查看预约；已经打开的页面每30秒刷新，手动刷新也可立即看到。姓名公开展示，电话只对本人凭管理码或已登录工作人员显示。可以继续通过电话查询、修改和取消预约；测试结束建议取消测试预约。

## 工作人员发起到场确认电话

在同一个本机服务运行期间，工作人员登录本机 `/admin`，找到未来的有效预约，手动点击到场确认电话操作。系统用Twilio号码拨打该预约保存的客户电话，以简短英语提示收集是否到场的回答。只有工作人员点击后才提交外呼；没有定时拨号。该流程独立于来电预约助手，即使 `VOICE_MODE=realtime` 也不连接OpenAI音频。

客户按1或说“I can attend”时保留预约；按2或说“I can’t attend”时进入取消复核，只有再按1或说“confirm cancellation”才会取消当前预约并释放时段。无人接听、挂断、没有听清或没有完成取消确认时，预约继续保留。后台以英语显示“No answer — booking kept”“Attendance confirmed”或取消结果，每30秒更新，也可以手动刷新。若预约在通话期间已被工作人员修改，旧回访不会更改新版本。

客户电话请填写带国家代码的国际号码，澳洲手机也可使用04开头的本地格式。没有联系电话、已开始或已取消的预约不能发起回访。重复点击只提交一次拨号；结果待确认时不要反复拨打，应先核对Twilio通话记录。

外呼必须配置同一Twilio账号的 `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN` 和支持Voice的E.164格式 `TWILIO_PHONE_NUMBER`，并具有公网HTTPS `APP_BASE_URL`。`phone:local` 和 `sms:local` 自动提供当前ngrok地址，无需部署或购买域名。程序以Twilio号码为主叫、预约中的客户电话为被叫，自动设置带预约关联信息的 **POST `/api/webhooks/attendance`**；不需要在Twilio控制台手工填写这个地址，号码的 **A CALL COMES IN** 继续保留 `/api/webhooks/voice`。

如果已有来电接入却提示缺少 `TWILIO_ACCOUNT_SID`，在自己电脑现有 `.env.local` 补充控制台中的SID，再按 **Ctrl+C** 停止旧服务，运行 `npm run phone:check` 和 `npm run phone:local`，需要短信时用 `npm run sms:local`。不要覆盖已有配置或删除 `.data`。试用账号可能要求先验证客户目标号码；外呼会产生Twilio通话费用。预检与自动化测试不会拨打真实电话，首次手机验收请使用自己获准测试的号码。

这两个电话端点只转发带Twilio签名的POST回调；签名、主被叫号码与预约关联由应用校验。GET、后台、预约列表和其他HTTP路径不会通过隧道开放；`sms:local` 另允许短信回调。

## 常见问题

- **Missing变量**：把已有值保存在当前项目、本机的 `.env.local`，重新运行预检；不要将密钥发到聊天中。
- **后台无法外呼到场确认**：按上节补齐SID并重启，确认ngrok仍运行、客户电话有效；试用账号检查目标号码验证和地区权限。
- **ngrok失败**：查看终端的 `ERR_NGROK_…` 错误码，检查Authtoken、账号开发域名与网络。可提供错误码，不需要提供密钥。
- **Twilio11200或无法回调**：检查终端是否仍运行、号码VoiceWebhook是否为最新完整地址且为POST，以及ngrok连接状态。
- **Twilio回调403**：检查该号码所属账号的Auth Token是否正确，号码和国家代码是否匹配。不要绕过签名校验；使用本脚本可避免旧APP_BASE_URL导致地址不一致。
- **隐藏来电号码**：当前接口要求正常E.164来电显示，请先使用普通手机号码测试。
- **网站没有立即出现电话预约**：等下一次自动刷新或手动刷新，并确认在同一个项目目录中查看同一份数据库。

需要协助时，只需提供：预检的变量名状态、脚本输出的公开Webhook地址、ngrok或Twilio错误码、来电大致时间。不要提供Auth Token、ngrokAuthtoken、管理码、完整语音转写或客户联系方式。

## 验证范围

自动化测试验证回调的原始请求体、查询串、Twilio签名保留，其他路径拒绝，敏感头剥离，超时和大小限制，以及语音确认到共享预约数据库的完整流程。确认短信也使用模拟服务，不发送真实短信。真实隧道账号、真实号码语音服务、实际通话与短信送达必须在本机填好凭据后验证，不能用模拟测试结果替代。

## 语音提示重复时的排查

程序支持“I’d like to book”“book tomorrow”“reserve a court”等英语预约表达。升级代码后，先用原来的 `phone:local` 终端按 Ctrl+C 停止，再运行 `git pull` 和 `npm run phone:local`。如果使用下载的源码包，请更新程序文件并保留原来的 `.env.local` 和 `.data`。隧道地址如改变，更新Twilio号码的Voice POST回调地址。

需要进一步排查时，停止旧服务并运行 `npm run phone:diagnose`。它使用同样的本机隧道流程，自动打开脱敏诊断，不需要改写密钥或配置文件。也可继续在 `.env.local` 使用 `VOICE_DEBUG=1`。终端仅输出路由、识别字段状态及步骤等元数据，不输出实际语音、电话号码或管理码。

```text
Voice callback: {"version":"mandarin-gather-2","turn":"present","input":"speech","handling":"routed", ...}
```

- `input=speech` 表示服务器收到语音识别结果；`input=empty` 表示本轮没有收到有效语音或按键。
- `turn=present` 表示收到会话标识；`handling=recovery` 表示回调缺少或带错会话标识，程序只重问当前问题，不会提交或重置预约。
- `speechField` 区分最终识别字段缺失、空白或有内容；`speechLength` 只显示字符数。`confidence` 是服务商返回的置信度（可能不提供）。`partialFieldPresent` 仅提示部分结果存在，部分结果不会当作最终确认。
- `stepBefore`、`stepAfter` 显示实际步骤。“按2后说I’d like to book tomorrow”在最终英语识别正常时，应识别日期并继续询问开始时间，`dateRecognized=true`，不会要求选择球场。
- 英语采集配置使用 `configuredLanguage=en-AU`，`responseLanguage` 表示实际返回的Gather语言；播报同样使用 `en-AU`，声音为 `Polly.Olivia-Neural`。`phone:check` 会显示 `English ASR en-AU`；Realtime模式则显示 `English transcription en`。
- 如 `cached=true` 且 `responseLanguage` 仍为旧版中文语言代码，说明旧通话重试拿到了升级前的缓存响应，请挂断后重新拨号，不要删除预约数据库。
- 正常后续请求应使用程序返回的Gather action地址，其中带 `?turn=...`，不要将后续步骤手工重定向到初始欢迎地址。

可以提供这些状态、错误码和 `git rev-parse --short HEAD` 输出的版本号，不需要发送Auth Token、实际语音转写、管理码或客户联系方式。
