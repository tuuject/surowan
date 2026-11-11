---
title: 配置 Provider 与模型
description: 显式启用可用模型，并为 Agent 与视觉分析选择合适的能力。
---

# 配置 Provider 与模型

Surowan 只使用配置 `providers.<alias>.models` 中显式列出的模型；Provider 目录里存在不代表运行时可选。主 Agent 模型必须支持 `text`，视觉模型必须支持 `image`，每个模型的上下文、输出上限与成本元数据都要写入配置。

## 从样例开始

[完整样例](__DOCS_BASE__/examples/config.example.jsonc) 使用一个 `custom` Provider。将以下信息替换成你的服务实际值：

1. `base_url` 和 API 协议（`openai-responses`、`openai-completions`、`anthropic-messages` 或 `google-generative-ai`）。
2. 环境变量名；不要把 key 填入 `api_key`。
3. 模型 ID、输入能力、上下文窗口、输出上限和成本。示例 ID 是占位值，不能保留。
4. `agent.provider` / `agent.model` 与 `vision.provider` / `vision.model` 的引用。

推理模型可声明 `reasoning: true` 和可接受的 `thinking_levels`；否则选择 `off`。模型的 `max_tokens` 不能大于 `context_window`，视觉的 `max_output_tokens` 不能超过所选模型上限。

模型条目可以加可选的 `nickname`（1–64 字符），用于在 Telegram 命令里隐藏真实的 Provider 与模型名：

```jsonc
{
  "providers": {
    "gateway": {
      "models": [
        {
          "id": "replace-with-your-text-and-image-model",
          "name": "Replace with an available model",
          "nickname": "常用聊天模型 A",
          "reasoning": false,
          "input": ["text", "image"],
          "context_window": 128000,
          "max_tokens": 8192,
          "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 }
        }
      ]
    }
  }
}
```

设置后，`/status`、`/model`、`/effort` 中该模型只显示昵称，不显示 Provider、模型 ID 或括号里的上游 `name`；`/model` 列表行变成 `3. 常用聊天模型 A`。没有设置昵称的模型保持 `provider / model` 的原有显示；昵称不要求唯一，也不影响 `/model 序号` 的切换位置。`nickname` 只改展示，定位、切换与校验仍使用真实 `id`。Admin Panel 是运维界面，继续显示真实 Provider 与模型名，模型编辑对话框可以填写昵称。

## 在管理面板中分配模型

Admin **模型 / Models** 页有三张卡片：Agent 模型、图片识别模型（Vision）与工具模型（Tool Model）。每张卡片先选模型，再在下方选思考强度；模型列表只列出能做这项工作的模型（图片识别要求 image 输入），思考强度只列该模型接受的级别，不推理的模型不能调节。改动不会立即写入：有改动的卡片标题旁会出现小圆点，底部保存栏显示未保存的数量，点 **保存 / Save** 后一并写入并热应用，点 **放弃更改 / Discard changes** 则恢复成已保存的设置。

**供应商 / Providers** 页维护 Provider 和模型列表。每个模型行下方有「用作 / Use as」按钮组：已高亮的是它当前担任的工作，点一下其它按钮就把那项工作交给这个模型。思考强度仍在模型页调整。

### 添加模型

在 **供应商 / Providers** 页选中 Provider，点 **获取模型列表 / Fetch models**：弹窗一打开就用这个 Provider 已保存的连接和 API Key 拉取它提供的模型，不需要再填 Key；要刷新列表点 **重新获取 / Fetch again**。如果连接设置刚改过还没应用，弹窗会直接报错，先保存并应用连接设置再获取。列表里拿不到的模型可以用 **手动添加 / Add manually** 按模型 ID 查询。

模型参数从 Provider 自己的列表（OpenRouter、Vercel、Gemini）和 [models.dev](https://models.dev) 查询，规则是：

- 模型 ID 能准确匹配时，上下文长度、最长输出、输入类型与思考档位直接填入，不用逐项确认；即使 models.dev 里这个模型列在别的供应商名下也一样。
- 价格：能匹配到这个 Provider 自己的价格就用它；匹配不到但 models.dev 有这个模型的价格时，取各部署里最贵的价格（输入、输出、缓存读写各取最高）；完全没有价格时写 0。价格从不需要确认，保存后可以在编辑弹窗里修改。
- 查不到是否支持思考时，按不支持思考的模型添加，列表里会显示提示。
- 只有上下文长度、最长输出、输入类型查不到（或只匹配到名字相近的模型）时，该模型才标记「N 项待确认」，必须进编辑弹窗填写或确认后才能添加。

查询地址默认是 `https://models.dev/api.json`，可以在 [Developer 页面](admin-developer.md#模型参数来源)换成镜像。

图片识别模型的思考强度写入 `vision.thinking_level`（可选）。不写时，推理模型用 `low`（模型不接受 `low` 时用它最弱的非 `off` 级别），非推理模型不发送思考参数。只切换图片识别模型时，原来的级别若不被新模型接受，会自动删除并回到这个默认值。

## 为辅助任务选择 Tool Model

Admin **模型 / Models** 页的 Tool Model 用于辞典融合、群聊记忆整理等辅助任务。未单独配置时，继承全局 Agent 的 Provider、模型和 thinking 级别；按群模型覆盖不会改变这个默认值。可以选择其他已配置且支持文本输入的模型，并设置该模型接受的 thinking 级别；恢复继承会删除单独的选择。

保存后热应用，之后开始的辅助任务使用新配置。辞典融合会真实调用模型并可能计费，但生成结果只是建议，必须审阅并确认后才保存词条。模型调用失败不影响普通辞典管理。操作步骤见[辞典指南](../guides/dictionary.md)。

## 选择原则

- 主 Agent：需要可靠的文本、工具调用与足够上下文；若要直接理解普通图片，也需 image 输入。
- Vision：用于图片与 Sticker 分析，单独有并发和日预算；不等于主 Agent 的成本预算。`vision` 段可省略，未配置时 `read_image` 不可用、Sticker 后台索引暂停，多模态主模型仍直接接收新消息里的图片。
- 先以保守预算和并发上线，再通过管理面板 Usage 与审计观察实际用量。

## 生效与验证

Provider 定义、模型列表、Agent 模型和视觉模型可以热应用，下一次 Invocation/视觉分析使用新快照。在 **模型 / Models** 页或供应商页「用作 Agent」切换全局 Agent 模型时，如果有会话还在用旧模型（跟随全局模型的 Chat；有自己模型的 Chat 不算），面板会先弹窗确认：确认后这些会话立即终止，它们正在处理的那批消息不再回复、不重新处理，之前委派的任务不受影响，群友之后的消息马上由新模型处理；取消则不保存。新模型直接沿用现有上下文，超出新模型能保留的范围时，下一次会话开始时自动重建。手改配置文件后应用，或用 Telegram 的 `/model` 切换时，运行中的 Invocation 不会中途换模型。用 Admin **模型 / Models** 或 **供应商 / Providers** 页保存，或修改文件后点击 **Apply config file**；随后查看 `config_reloaded`。

### 在供应商页面做健康检查

在 Admin **供应商 / Providers** 页选中 Provider，点击模型行中的 **测试 / Test** 图标按钮。要测试多个模型，勾选行首复选框，再点击 **测试所选 / Test selected (N)**；可以全选当前 Provider，也可以切换 Provider 后继续选择。一次批量最多同时发出 3 个请求，每项独立显示结果。

检查使用已经生效的 Provider 连接，唯一提示词为：

```text
reply with extract content: ok
```

这是实际模型调用，可能产生费用，但不切换当前 Agent 或 Vision 模型，也不附带聊天历史、人格 Prompt 或工具。每次检查最多等待 30 秒，不自动重试；Provider 或模型定义仍待应用时，需要先应用配置。

结果含状态、首次响应耗时和总耗时；展开该行可查看响应文本或错误：

- **正常 / OK**：正常结束，去掉首尾空白后的文本恰好是小写 `ok`。
- **回复不符预期 / Unexpected reply**：正常收到非空文本，但不是 `ok`，不等于连接失败。
- **失败 / Failed**：请求失败、超时、空响应或未正常完成（例如输出被截断）。

**首次响应 / First response** 以适配器报告收到 **HTTP 响应头** 为准，不是首个生成 Token，也不是总耗时；无法观测时显示 **无法测量 / unavailable**。结果只保留在当前页面，刷新或离开后清空。离开 Providers 页面会停止尚未发出的检查，并取消在途请求，但供应商已接收的调用仍可能计费。调用用量作为 `doctor` 诊断记录进入审计；文本检查不验证工具调用、图片理解或实际群聊参与能力。

### 完整依赖诊断

在有真实凭据且允许消耗 Token 的环境运行：

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
```

Doctor 是实际连通性探针，不是离线 lint。模型失败时不要猜模型名，检查 Provider 返回与 [排查问题](../operations/troubleshooting.md)。
