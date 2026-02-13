# 更新内容

## 2026-02-13

### wecom-app

- 增强语音转写（ASR）能力
  - 入站 `voice` 消息优先走云端 ASR 转写。
  - 转写成功后在消息体追加识别文本（`[recognition] ...`）。
  - ASR 失败时自动回退到企业微信原生 `Recognition` 字段（若存在）。

- 增强语音发送兼容（wav/mp3 → amr）
  - 新增 `voiceTranscode.enabled` 配置。
  - 发送 `wav/mp3` 时，若检测到 `ffmpeg`，自动转码为 `amr` 再按语音发送。
  - 若无 `ffmpeg` 或转码失败，自动降级为文件发送，保证消息可达。

- 位置消息（location）解析能力完善（已验证）
  - 解析 XML 中的 `Location_X`、`Location_Y`、`Scale`、`Label` 字段。
  - 统一输出格式：`[location] 纬度,经度 地址 scale=缩放级别`。
  - 已通过多次真机发送定位消息验证（含经纬度与中文地址）。

- 兼容说明
  - 同时可接收 `Event=LOCATION` 事件（`Latitude/Longitude/Precision`）用于位置上报场景。
  - `MsgType=location` 与 `Event=LOCATION` 属于不同回调类型，插件已分别处理。

- 相关代码范围
  - `extensions/wecom-app/src/monitor.ts`
  - `extensions/wecom-app/src/bot.ts`
  - `extensions/wecom-app/src/types.ts`
  - `extensions/wecom-app/src/config.ts`
  - `extensions/wecom-app/openclaw.plugin.json`
