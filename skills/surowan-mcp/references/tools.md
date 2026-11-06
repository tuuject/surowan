# 工具索引

工具名由 Admin Panel 命令生成：`surowan_<command>`，空格与连字符变为下划线。每个工具的参数包含路径参数、查询参数、可选的 `body` 对象、需要时的 `if_match`，以及破坏性/计费操作的 `confirm`。`dry_run` 可预览请求。

## Invocation 与审计

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `surowan_invocation_list` | read | 列出 Invocation，支持 chat/state/host/model/search/at/from/to |
| `surowan_invocation_show` | read | 单条 Invocation 详情 |
| `surowan_invocation_prompts` | read | 当前 global/group prompt 模板 |
| `surowan_invocation_replay_preflight` | read | 免费重放预检 |
| `surowan_invocation_media` | read | 列出快照授权媒体 |
| `surowan_invocation_media_content` | read | 下载原始/预览媒体；图片返回 image，其余返回 base64 `resource.blob`，上限 16 MiB |
| `surowan_invocation_replay` | paid | 重放，真实调用模型；需 `confirm: true` |
| `surowan_invocation_tool_image` | read | 工具调用产生的图片；`tool_call_id` 与 `asset_id` 是字符串 |
| `surowan_context_message_image` | read | Context 消息图片；`asset_id` 是字符串 |
| `surowan_overview` | read | 总览 |
| `surowan_usage` | read | 用量序列 |
| `surowan_context_list` / `surowan_context_show` | read | Conversation Context |
| `surowan_message_list` / `surowan_message_show` | read | Telegram 消息与 Revision |
| `surowan_sticker_set_list` / `surowan_sticker_list` | read | Sticker 索引 |
| `surowan_alarm_list` / `surowan_alarm_cancel` | read / write | Alarm 查询与取消 |
| `surowan_config_view` | read | 脱敏配置 |
| `surowan_models_list` | read | active 文本模型 |
| `surowan_key_show` | read | 当前 key 的权限 |
| `surowan_version_show` | read | 运行中的版本号与 Channel |

## 配置、模型与 Harness

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `surowan_config_apply` / `surowan_config_status` | write / read | 应用/查看配置 |
| `surowan_harness_show` / `surowan_harness_update` | read / write | agent 段调优 |
| `surowan_model_set` / `surowan_vision_set` / `surowan_thinking_level_set` | write | 全局模型与 thinking |
| `surowan_provider_list` / `surowan_provider_create` / `surowan_provider_update` / `surowan_provider_delete` | read / write | Provider 管理 |
| `surowan_provider_discover` / `surowan_provider_lookup_metadata` | write | Provider 模型发现 |
| `surowan_provider_health_check` | paid | 真实模型健康检查 |
| `surowan_model_add` / `surowan_model_update` / `surowan_model_delete` | write | Provider 模型列表 |
| `surowan_provider_preset_list` | read | 内置 Provider 预设 |
| `surowan_developer_show` / `surowan_developer_update` / `surowan_developer_clear_payloads` | read / write | Developer 页 |
| `surowan_search_show` / `surowan_search_update` | read / write | 网络搜索配置 |
| `surowan_telegram_show` / `surowan_telegram_token` / `surowan_telegram_token_clear` | read / write | Telegram token |
| `surowan_bot_admin_list` / `surowan_bot_admin_add` / `surowan_bot_admin_remove` | read / write | Bot 管理员 |
| `surowan_restart` / `surowan_wake` / `surowan_session_cancel` | write | 进程与会话控制 |

## Chat、Prompt 与知识

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `surowan_chat_list` / `surowan_chat_create` / `surowan_chat_update` / `surowan_chat_delete` | read / write | Chat 与 Topic |
| `surowan_chat_participation` / `surowan_chat_proactive_reply` / `surowan_chat_group_memory` | write | 单 Chat 覆盖 |
| `surowan_prompt_global_view` / `surowan_prompt_group_view` | read | 当前 Prompt |
| `surowan_prompt_versions` / `surowan_prompt_version_show` / `surowan_prompt_diff` | read | 版本历史与 diff |
| `surowan_prompt_save` / `surowan_prompt_restore` / `surowan_prompt_cancel_running` | write | Prompt 写入/恢复/取消运行 |
| `surowan_dictionary_list` / `surowan_dictionary_chats` / `surowan_dictionary_export` | read | 辞典读取 |
| `surowan_dictionary_create` / `surowan_dictionary_update` / `surowan_dictionary_delete` | write | 辞典词条 |
| `surowan_dictionary_settings_show` / `surowan_dictionary_settings_update` | read / write | 注入模式 |
| `surowan_dictionary_import_preview` / `surowan_dictionary_import_apply` | read / write | 批量导入 |
| `surowan_dictionary_merge_preview` / `surowan_dictionary_merge_apply` | paid / write | 辞典融合 |
| `surowan_tool_model_set` | write | 辅助模型 |
| `surowan_memo_list` / `surowan_memo_chats` / `surowan_memo_blob_content` | read | Memo Pad |
| `surowan_memo_create` / `surowan_memo_update` / `surowan_memo_delete` | write | Memo Pad 写入 |
| `surowan_group_memory_list` / `surowan_group_memory_messages` | read | 群聊记忆 |
| `surowan_group_memory_update` / `surowan_group_memory_delete` | write | 群聊记忆修改 |
| `surowan_warning_list` / `surowan_warning_read` / `surowan_warning_clear` | read / write | 警告 |

## 图片与 Playground

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `surowan_image_status` / `surowan_image_config_show` | read | 图片状态与配置 |
| `surowan_image_config_update` | write | 图片配置 |
| `surowan_image_model_list` / `surowan_image_model_endpoints` | read | 图片模型 |
| `surowan_image_prompt_list` / `surowan_image_prompt_show` | read | 生图 Prompt |
| `surowan_image_prompt_create` / `surowan_image_prompt_update` / `surowan_image_prompt_archive` | write | 生图 Prompt 管理 |
| `surowan_image_asset_list` / `surowan_image_asset_show` / `surowan_image_asset_content` | read | 参考图 |
| `surowan_image_asset_upload` / `surowan_image_asset_update` / `surowan_image_asset_archive` | write | 参考图管理 |
| `surowan_image_generation_resolve` | read | 免费解析生成请求 |
| `surowan_image_generation_list` / `surowan_image_generation_show` | read | 生成记录 |
| `surowan_image_generation_create` / `surowan_image_generation_retry` | write+paid | 真实生图 |
| `surowan_room_list` / `surowan_room_show` / `surowan_room_messages` | read | Playground 房间 |
| `surowan_room_create` / `surowan_room_participant_add` / `surowan_room_send` / `surowan_room_hold` / `surowan_room_capabilities` | write | 房间操作 |
| `surowan_room_asset_list` / `surowan_room_asset_upload` / `surowan_room_asset_content` | read / write | 房间图片 |
| `surowan_room_release` / `surowan_room_release_retry` | write+paid | Release 与重试 |
| `surowan_room_release_show` / `surowan_room_invocations` / `surowan_room_invocation_show` | read | Release 与房间审计 |

## 错误

- `forbidden`：权限不足；停止并请用户改 API key 模式。
- `config_conflict` / `prompt_conflict` / `dictionary_conflict`：并发修改；重新读取并重新确认。
- `invalid_body` / `invalid_query`：参数不符合端点契约；修正后重试，不要猜字段。
- `replay_unavailable` / `replay_scene_unavailable`：重放未接线或场景不可用；报告，不伪造输入。
- `confirmation_required`：破坏性或计费工具缺少 `confirm: true`。
