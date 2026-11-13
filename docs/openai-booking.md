# Gather电话和短信使用GPT理解预约文本

本页说明 `BOOKING_AI_ENABLED` 控制的Responses API文本理解。希望GPT直接听电话音频并生成语音，请按[OpenAI Realtime电话接入](realtime-phone.md)设置 `VOICE_MODE=realtime`；两项功能使用不同模型设置，Realtime不依赖本页开关。

本功能默认关闭。启用后，GPT理解电话语音转写和短信里的预约表达，例如“Is a court available tomorrow at 3 pm?”，并提取日期、场地、开始时间、时长等字段。空档和预约结果仍由本机SQLite数据库决定。自然语言创建、修改或取消预约会先复述信息，等待客户下一轮明确确认，再重新校验并写入。

在 `VOICE_MODE=gather` 时，电话的语音识别和播报继续使用Twilio（澳洲英语 `en-AU`，`Polly.Olivia-Neural`），本页功能只处理文本。原有固定短信指令和按键流程继续可用；邮件仍使用原来的固定指令，本次不接入GPT。固定短信指令保持原来的执行方式，不能将它们当成带确认步骤的自然语言测试。

## 1. 没有OpenAI API账号时，先开通账号和计费

1. 打开 [https://platform.openai.com](https://platform.openai.com)，注册或登录，并按平台提示完成账号、组织或项目设置。
2. 在平台的Billing页面为API开通计费，按账号显示的要求添加支付方式或余额。**ChatGPT订阅和OpenAI API分别计费**；已有ChatGPT订阅不代表本项目已经可以调用API。
3. 在准备使用的项目中打开 [API keys](https://platform.openai.com/api-keys)，创建供本项目服务器使用的API key，妥善保存。若使用受限密钥，需允许调用Responses API。
4. 在项目的Usage、Limits或Billing页面检查额度和使用情况，并设置适合自己的预算通知。预算通知可能是提醒或软限制，不能假定它能保证硬性封顶；以平台实际提供的控制和条款为准。

OpenAI API调用与Twilio号码、通话、语音识别和短信费用分别计费；ngrok套餐也以其账号规则为准。请查看各自控制台的当前价格和限制，本说明不承诺价格或免费额度。

## 2. 在自己电脑补充配置

编辑项目根目录已有的 `.env.local`，保留原来的Twilio、ngrok和数据库配置，补充下面三项。将说明文字替换为自己的真实API key，不要原样使用：

```dotenv
BOOKING_AI_ENABLED=1
OPENAI_API_KEY=这里填写自己的项目API密钥
OPENAI_MODEL=gpt-4.1-mini
```

- `BOOKING_AI_ENABLED=1` 才启用本页文本理解；默认值为 `0`。它不控制Realtime音频。`VOICE_MODE=gather` 且本开关关闭时不调用OpenAI，原有预约流程仍可使用。
- `OPENAI_API_KEY` 只供服务器使用。不要改成 `NEXT_PUBLIC_OPENAI_API_KEY`，不要放进网页、Git、截图或聊天，也不要覆盖已有 `.env.local` 或删除 `.data`。
- `OPENAI_MODEL` 可省略，默认 `gpt-4.1-mini`。它只用于Responses API及严格JSON Schema文本输出，不要填Realtime音频模型。默认选择不代表它是最新模型，也不保证每个账号都有访问权限。换模型前，确认项目有权限且模型支持该输出方式。

这些配置在重启后生效。部署到服务器时，应使用部署平台的服务端环境变量设置，并允许服务器通过HTTPS访问 `api.openai.com`。

## 3. 停止旧服务，更新并重启

先在旧 `phone:local`、`sms:local` 或开发服务的终端按 **Ctrl+C**。在原项目目录更新并检查：

```bash
git pull
npm run phone:check
npm run ai:check
```

首次安装或更新代码涉及依赖变化时，先执行 `npm ci --include=dev`。需要Node.js 24.5以上的24.x版本，推荐仓库 `.nvmrc` 指定的版本。

预检成功时会显示类似：

```text
Booking language: GPT (model gpt-4.1-mini)
```

预检不会显示API key，也不会联网验证OpenAI账号、余额、模型权限或实际回复。若缺少密钥，它只会指出 `OPENAI_API_KEY`；`BOOKING_AI_ENABLED` 只接受 `0` 或 `1`，模型名必须使用安全格式。看到GPT模式只说明配置已选择该模式，不能据此认定实际API调用成功。

`npm run ai:check` 会额外向OpenAI发送一次简短的预约查询理解请求，使用少量API额度，不会查询或写入预约数据库。成功应显示 `GPT API check passed`；失败时检查自己的API项目密钥、计费、模型权限和网络。检查过程不会打印密钥或服务商响应正文。

这项检查只验证Responses API文本理解；即使成功，也不代表 `OPENAI_REALTIME_MODEL` 可用或Realtime电话音频已经接通。

同时接收电话和短信：

```bash
npm run sms:local
```

仅接收电话：

```bash
npm run phone:local
```

不要同时运行两份服务。保持电脑、网络和终端运行；预约继续保存在原来的本机数据库中。如果新启动的隧道域名改变，将Twilio号码的Voice **A call comes in** 和启用短信时的Messaging **A message comes in** 更新为本次终端输出的对应Webhook地址，方法均为 **HTTP POST**。不能用本机回环地址或网站首页代替回调地址。

首次接通Twilio和ngrok的操作见[本机电话说明](local-phone.md)和[本机短信说明](local-sms.md)。`phone:local` 不转发短信，需要电话和短信同时工作时使用 `sms:local`。

## 4. 用真实手机验证

先用未来日期查询真实空档，再选择实际可用时段测试。所有日期和时间均按 **Australia/Sydney** 解释。电话可以说“Can I book tomorrow at 3 pm for two hours?”，短信也可用自然语言询问或提出预约需求。按回复补齐字段，仔细核对复述的信息，最后再按提示明确确认。

自然语言请求本身不会跳过确认、身份校验、字段验证或时段冲突检查。短信收到汇总后，创建需另发一条“confirm booking”，修改需另发“confirm change”，取消需另发“confirm cancellation”；发送“no”或“stop”可放弃当前草稿。不要在首次请求中同时发送确认，等待系统复述后再确认。

修改、查看和取消仍需正确的预约编号及管理码，由本机程序核验。含凭据的输入跳过模型理解，请按系统提示提供，不要夹带其他个人信息。姓名会按产品规则显示在公开日程上，测试时请使用适合公开展示的姓名。

写入前打开本机网页核对日程，提交成功后刷新检查；测试完成后取消测试预约并核对空档已释放。对错误日期、含糊确认、否定回答、重复回调和已占用时段也应做检查，避免只验证一次顺利流程。

程序为模型请求设置约4秒超时。未启用GPT时使用原来的规则流程；启用后的请求超时、接口错误或输出不符合要求时，也会回到原来的规则和提示。模型不能替代数据库校验。若暂时无法完成自然语言请求，可使用系统提示、按键或[固定短信指令](local-sms.md)。尚未开通账号或未完成真实API调用时，不能把自动化模拟通过当作GPT已经接通；同样，GPT可用也不代表Twilio真实通话和短信链路已验证。

## 5. 数据范围、费用与关闭方法

以下数据范围仅适用于本页Responses API文本理解。Realtime会发送通话音频，可能包含电话、姓名、预约凭据等信息，见[Realtime隐私说明](realtime-phone.md#数据范围与费用)。

启用后，服务器会将需要理解的**短信文本或电话语音转写**和有限预约上下文发送给OpenAI；模型输入不含通话音频、完整数据库、整段历史会话或服务器密钥。API key仅用于服务器请求的身份认证。姓名可能包含在文本中并发送给OpenAI。

程序不会把已有联系方式、管理码或预约凭据作为模型上下文。电话收集预约编号、管理码及联系方式的步骤不会调用模型；含连续8位以上数字等疑似电话号码或凭据的输入也会跳过模型。但这不是完整的自动脱敏保证：请勿在自然语言内容中夹带密钥、管理码、联系方式或其他无关个人信息。

Responses API请求使用 `store:false`，表示不请求保存该响应供后续读取；这不等于承诺零留存。OpenAI的数据处理、滥用监测及账号可用的数据控制，应以其当前政策与项目设置为准。

通过OpenAI项目Usage页面核对调用和费用，通过Twilio日志核对通话与短信费用。遇到授权、额度或模型权限问题，先在自己的平台账号中检查；需要协助时只提供时间、脱敏错误码和预检状态，不要发API key、完整短信、语音转写、管理码或客户联系方式。

要关闭本页文本理解，在 `.env.local` 将 `BOOKING_AI_ENABLED=0`，按Ctrl+C停止旧服务，再重新运行原来的 `sms:local` 或 `phone:local`。预检或启动应显示 `Booking language: rule-based`。要同时关闭Realtime音频，还需将 `VOICE_MODE=gather` 并重启。如密钥曾泄露，请到OpenAI平台撤销并更换，而不是只在本地删除。
