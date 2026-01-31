# OpenClaw China

面向中国 IM 平台的 OpenClaw 扩展插件集合


[快速开始](#快速开始) · [演示](#演示) · [配置选项](#配置选项) · [开发](#开发)

| 平台 | 状态 |
|------|:----:|
| 钉钉 | ✅ 可用 |
| 飞书 | ✅ 可用 |
| 企业微信 | ✅ 可用 |
| QQ 机器人 | 🚧 开发中 |

## 功能支持

较多功能支持仍在努力开发中~

| 功能 | 钉钉 | 飞书 | 企业微信 |
|------|:----:|:----:|:--------:|
| 文本消息 | ✅ | ✅ | ✅ |
| Markdown | ✅ | ✅ | ✅ |
| 流式响应 | ✅ | ❌ | ✅ stream 回调 |
| 图片/文件 | ✅ 仅接收（发送开发中） | ❌ | ✅ 仅接收 |
| 语音消息 | ✅ 收发（接收为语音文本） | ❌ | ✅ 仅接收（语音文本） |
| 私聊 | ✅ | ✅ | ✅ |
| 群聊 | ✅ | ✅ | ✅ |
| @机器人检测 | ✅ | ✅ | ❌（未显式解析@） |
| 多账户 | ❌ | ❌ | ✅ |
| 连接方式 | Stream 长连接 | WebSocket 长连接 | HTTPS 回调 |

> 💡 **钉钉 AI Card** 支持打字机效果的流式输出，体验最佳。启用方式：`enableAICard: true`
>
> 💡 **飞书 Markdown 卡片** 启用方式：`sendMarkdownAsCard: true`
>
> 💡 **企业微信** 仅支持被动回复模式，不支持主动发送消息

## 快速开始

### 1) 安装

> 飞书、企业微信保姆文档编写中，现在最容易配置的是钉钉，建议先尝试钉钉。

**安装统一包（包含所有渠道）**

```bash
openclaw plugins install @openclaw-china/channels
```

**或者：安装单个渠道（不要和统一包同时安装）**

```bash
openclaw plugins install @openclaw-china/dingtalk
```

```bash
openclaw plugins install @openclaw-china/feishu
```

```bash
openclaw plugins install @openclaw-china/wecom
```

> ℹ️ 如果你使用的是旧名称 **clawbot**，请使用 `@openclaw-china/channels@0.1.12`。

### 2) 配置渠道

#### 钉钉

> 📖 **[钉钉企业注册指南](doc/guides/dingtalk/configuration.md)** — 无需材料，5 分钟内完成配置

```bash
openclaw config set channels.dingtalk '{
  "enabled": true,
  "clientId": "dingxxxxxx",
  "clientSecret": "your-app-secret",
  "enableAICard": true
}' --json
```

**可选高级配置**

如果你需要更细粒度控制（例如私聊/群聊策略或白名单），可以在 `~/.openclaw/openclaw.json` 中按需添加：

```json5
{
  "channels": {
    "dingtalk": {
      "dmPolicy": "open",          // open | allowlist
      "groupPolicy": "open",       // open | allowlist | disabled
      "requireMention": true,
      "allowFrom": [],
      "groupAllowFrom": []
    }
  }
}
```

#### 飞书

> 飞书应用需开启机器人能力，并使用「长连接接收消息」模式

openclaw:

```bash
openclaw config set channels.feishu '{
  "enabled": true,
  "appId": "cli_xxxxxx",
  "appSecret": "your-app-secret"
}' --json
```

#### 企业微信

> 企业微信智能机器人（API 模式）通过公网 HTTPS 回调接收消息，仅支持被动回复

```bash
openclaw config set channels.wecom '{
  "enabled": true,
  "webhookPath": "/wecom",
  "token": "your-token",
  "encodingAESKey": "your-43-char-encoding-aes-key"
}' --json
```

**注意事项**

- `webhookPath` 必须为公网 HTTPS 可访问路径（如 `https://your.domain/wecom`）
- `encodingAESKey` 必须为 43 位字符
- 如遇回调校验失败，先确认 Token/EncodingAESKey 与后台一致

### 3) 重启 Gateway

```bash
openclaw gateway restart
```

## 演示

以下为钉钉渠道效果示例：

![钉钉机器人演示](doc/images/dingtalk-demo_2.gif)

![钉钉机器人演示](doc/images/dingtalk-demo_3.png)

## 配置选项

> 通用字段适用于所有渠道；渠道专用字段仅在对应渠道生效。

### 通用字段

| 选项 | 说明 |
|------|------|
| `enabled` | 是否启用 |
| `dmPolicy` | 私聊策略：`open`（任何人）/ `allowlist`（白名单） |
| `groupPolicy` | 群聊策略：`open`（任何群）/ `allowlist`（白名单）/ `disabled`（禁用） |
| `requireMention` | 群聊中是否需要 @机器人 |
| `allowFrom` | 私聊白名单用户 ID |
| `groupAllowFrom` | 群聊白名单群 ID |


### 会话配置（可选）

`session.dmScope` 控制不同用户的会话隔离方式：

| 值 | 说明 |
|----|------|
| `main` | 所有用户共享同一会话（不推荐） |
| `per-peer` | **推荐**，按用户 ID 隔离 |
| `per-channel-peer` | 按渠道 + 用户隔离 |

## 开发

适合需要二次开发或调试的场景：

```bash
# 克隆仓库
git clone https://github.com/BytePioneer-AI/moltbot-china.git
cd moltbot-china

# 安装依赖并构建
pnpm install
pnpm build

# 以链接模式安装（修改代码后实时生效）
openclaw plugins install -l ./packages/channels
```

**示例配置（开发环境）**

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/OpenClaw-china/packages/channels"]
    },
    "entries": {
      "channels": { "enabled": true }
    }
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret"
    },
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxx",
      "appSecret": "your-app-secret"
    },
    "wecom": {
      "enabled": true,
      "webhookPath": "/wecom",
      "token": "your-token",
      "encodingAESKey": "your-43-char-encoding-aes-key"
    }
  }
}
```

对OpenClaw用法、插件感兴趣的可以加群交流。
欢迎同学们一起开发~

<img width="1222" height="1707" alt="4d16a9f91778b4ad0153c40733ae3042" src="https://github.com/user-attachments/assets/563160be-78ac-4cd5-b01c-d83c77e5e4b8" />


## License

MIT
