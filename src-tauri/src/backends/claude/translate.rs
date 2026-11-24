//! Claude Code `stream-json` 输出帧 → `UnifiedEvent` 状态机翻译器。
//!
//! 实机协议时序 (`claude 2.1.322 --output-format stream-json --include-partial-messages --verbose`):
//! ```text
//! system (init)
//! stream_event: message_start (id=M)           ← 消息真正开始
//!   stream_event: content_block_start (thinking)
//!   stream_event: content_block_delta (thinking_delta / signature_delta)
//!   assistant (id=M, blocks=[thinking])        ← 单块快照 (非消息结束! 不发 AssistantEnd)
//!   stream_event: content_block_stop
//!   stream_event: content_block_start (text)
//!   stream_event: content_block_delta (text_delta) × N  ← 真实流式打字机增量
//!   assistant (id=M, blocks=[text])            ← 单块快照 (已流式输出过, 绝不重复补发 text!)
//!   stream_event: content_block_stop
//!   (工具调用: content_block_start (tool_use) → input_json_delta × N → assistant (blocks=[tool_use]) → stop)
//! stream_event: message_delta (stop_reason, usage)
//! stream_event: message_stop                   ← 消息真正结束, 此时才发 AssistantEnd
//! user (tool_result)                           ← 工具执行结果
//! result (total_cost_usd, usage, is_error)     ← 整轮结束, 发 TurnSettled
//! ```

use crate::backends::plan::PlanTracker;
use crate::backends::prompt::{is_claude_ask_user_tool, parse_claude_ask_user_question};
use crate::backends::{
    ContentBlockKind, MessageUsage, NotifyLevel, PermissionOption, PermissionRequestPayload,
    UnifiedEvent,
};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Default)]
pub struct ClaudeStreamTranslator {
    in_turn: bool,
    /// 当前是否处于 `stream_event(message_start)` .. `stream_event(message_stop)` 窗口内
    active_stream: bool,
    current_msg_id: Option<String>,
    /// 所有已经走过 `stream_event` 流式路径的 `message.id`: 其后续 `assistant` 块快照不得重复补发 text/thinking
    streamed_msg_ids: HashSet<String>,
    /// 非流式兜底路径下已输出过的 `(msg_id, block_sig)` 防重复
    seen_tool_ids: HashSet<String>,
    /// 当前消息待结算的 usage / stop_reason (由 message_start / assistant 快照 / message_delta 不断更新, 到 message_stop 一次性结算)
    pending_usage: Option<MessageUsage>,
    pending_stop_reason: Option<String>,
    /// 本轮内是否已由 assistant_end 结算过 usage (防止 result 重复加倍)
    turn_had_usage: bool,
    /// 会话级任务清单追踪器 (TodoWrite / TaskCreate / TaskUpdate 统一归一)
    plan_tracker: PlanTracker,
}

impl ClaudeStreamTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn translate(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(ev_type) = frame.get("type").and_then(|v| v.as_str()) else {
            return Vec::new();
        };

        match ev_type {
            "system" => self.handle_system(frame),
            "stream_event" => self.handle_stream_event(frame),
            "assistant" => self.handle_assistant(frame),
            "user" => self.handle_user(frame),
            "result" => self.handle_result(frame),
            "control_request" => self.handle_control_request(frame),
            _ => Vec::new(),
        }
    }

    fn ensure_turn_started(&mut self, out: &mut Vec<UnifiedEvent>) {
        if !self.in_turn {
            self.in_turn = true;
            self.turn_had_usage = false;
            out.push(UnifiedEvent::TurnStart);
        }
    }

    fn handle_system(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let subtype = frame.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if subtype != "init" {
            return Vec::new();
        }
        let session_id = frame
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let model = frame
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let permission_mode = frame
            .get("permissionMode")
            .or_else(|| frame.get("permission_mode"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        vec![UnifiedEvent::SessionMeta {
            session_path: None,
            remote_session_id: session_id,
            model,
            permission_mode,
        }]
    }

    fn handle_stream_event(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(ev) = frame.get("event") else {
            return Vec::new();
        };
        let Some(sub) = ev.get("type").and_then(|v| v.as_str()) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(3);

        match sub {
            "message_start" => {
                self.ensure_turn_started(&mut out);
                let msg = ev.get("message");
                let message_id = msg
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(id) = &message_id {
                    self.streamed_msg_ids.insert(id.clone());
                }
                self.current_msg_id = message_id.clone();
                self.active_stream = true;
                self.pending_usage = msg.and_then(|m| m.get("usage")).map(parse_claude_usage);
                self.pending_stop_reason = None;

                out.push(UnifiedEvent::AssistantStart { message_id });
                if let Some(u) = &self.pending_usage {
                    if u.input > 0 || u.output > 0 {
                        out.push(UnifiedEvent::LiveUsage {
                            input: u.input,
                            output: u.output,
                        });
                    }
                }
            }
            "content_block_start" => {
                self.ensure_turn_started(&mut out);
                let bt = ev
                    .get("content_block")
                    .and_then(|b| b.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match bt {
                    "text" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Text,
                    }),
                    "thinking" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Thinking,
                    }),
                    "tool_use" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::ToolCall,
                    }),
                    _ => {}
                }
            }
            "content_block_delta" => {
                self.ensure_turn_started(&mut out);
                let Some(delta) = ev.get("delta") else {
                    return out;
                };
                let dt = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match dt {
                    "text_delta" => {
                        let s = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !s.is_empty() {
                            out.push(UnifiedEvent::TextDelta {
                                delta: s.to_string(),
                            });
                        }
                    }
                    "thinking_delta" => {
                        let s = delta
                            .get("thinking")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !s.is_empty() {
                            out.push(UnifiedEvent::ThinkingDelta {
                                delta: s.to_string(),
                            });
                        }
                    }
                    "input_json_delta" => {
                        let s = delta
                            .get("partial_json")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        out.push(UnifiedEvent::ToolCallDelta {
                            has_delta: !s.is_empty(),
                        });
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(sr) = ev
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|v| v.as_str())
                {
                    self.pending_stop_reason = Some(sr.to_string());
                }
                if let Some(u) = ev.get("usage") {
                    let parsed = parse_claude_usage(u);
                    // message_delta 的 usage 通常携带最终 output_tokens; 合并进 pending_usage 保留 input/cache
                    match &mut self.pending_usage {
                        Some(prev) => {
                            if parsed.input > 0 {
                                prev.input = parsed.input;
                            }
                            if parsed.output > 0 {
                                prev.output = parsed.output;
                            }
                            if parsed.cache_read > 0 {
                                prev.cache_read = parsed.cache_read;
                            }
                            if parsed.cache_write > 0 {
                                prev.cache_write = parsed.cache_write;
                            }
                        }
                        None => {
                            self.pending_usage = Some(parsed.clone());
                        }
                    }
                    if parsed.input > 0 || parsed.output > 0 {
                        out.push(UnifiedEvent::LiveUsage {
                            input: parsed.input,
                            output: parsed.output,
                        });
                    }
                }
            }
            "message_stop" => {
                if self.active_stream {
                    let usage = self.pending_usage.take();
                    if usage.is_some() {
                        self.turn_had_usage = true;
                    }
                    let stop_reason = self.pending_stop_reason.take();
                    out.push(UnifiedEvent::AssistantEnd {
                        usage,
                        stop_reason,
                        error_message: None,
                    });
                    self.active_stream = false;
                    self.current_msg_id = None;
                }
            }
            _ => {}
        }
        out
    }

    fn handle_assistant(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(msg) = frame.get("message") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        self.ensure_turn_started(&mut out);

        let msg_id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 只要该 message.id 已走过 stream_event (或当前正在流式输出中),
        // 这里的 assistant 只是单个 content_block 完成后的快照:
        // - 绝不重复补发 text / thinking (防回答重复两遍)
        // - 绝不提前发 AssistantEnd 清空 currentAssistantId (防吞掉后续 text_delta 失去打字机效果)
        let is_streamed = self.active_stream
            || msg_id
                .as_ref()
                .map(|id| self.streamed_msg_ids.contains(id))
                .unwrap_or(false);

        if let Some(u) = msg.get("usage") {
            let parsed = parse_claude_usage(u);
            if self.active_stream {
                self.pending_usage = Some(parsed);
            }
        }
        if let Some(sr) = msg.get("stop_reason").and_then(|v| v.as_str()) {
            if self.active_stream {
                self.pending_stop_reason = Some(sr.to_string());
            }
        }

        if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
            let mut started_fallback = false;
            for block in content {
                let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match bt {
                    "text" if !is_streamed => {
                        let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            if !started_fallback {
                                out.push(UnifiedEvent::AssistantStart {
                                    message_id: msg_id.clone(),
                                });
                                started_fallback = true;
                            }
                            out.push(UnifiedEvent::TextDelta {
                                delta: text.to_string(),
                            });
                        }
                    }
                    "thinking" if !is_streamed => {
                        let thinking = block
                            .get("thinking")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !thinking.is_empty() {
                            if !started_fallback {
                                out.push(UnifiedEvent::AssistantStart {
                                    message_id: msg_id.clone(),
                                });
                                started_fallback = true;
                            }
                            out.push(UnifiedEvent::ThinkingDelta {
                                delta: thinking.to_string(),
                            });
                        }
                    }
                    "tool_use" => {
                        let tool_call_id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !tool_call_id.is_empty() && self.seen_tool_ids.insert(tool_call_id.clone())
                        {
                            let tool_name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let args = block.get("input").cloned().unwrap_or(Value::Null);
                            let maybe_plan =
                                self.plan_tracker
                                    .ingest_tool_start(&tool_call_id, &tool_name, &args);
                            out.push(UnifiedEvent::ToolStart {
                                tool_call_id,
                                tool_name,
                                args,
                            });
                            if let Some(plan) = maybe_plan {
                                out.push(UnifiedEvent::PlanUpdate { plan });
                            }
                        }
                    }
                    _ => {}
                }
            }
            // 非流式兜底消息才在这里立即结算
            if !is_streamed && started_fallback {
                let usage = msg.get("usage").map(parse_claude_usage);
                if usage.is_some() {
                    self.turn_had_usage = true;
                }
                let stop_reason = msg
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                out.push(UnifiedEvent::AssistantEnd {
                    usage,
                    stop_reason,
                    error_message: None,
                });
            }
        }

        out
    }

    fn handle_user(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(content) = frame
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            let tool_call_id = block
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tool_call_id.is_empty() {
                continue;
            }
            let is_error = block
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let raw_content = block.get("content").cloned().unwrap_or(Value::Null);
            let normalized_result = normalize_tool_result_content(raw_content);
            let maybe_plan = self
                .plan_tracker
                .ingest_tool_end(&tool_call_id, &normalized_result);
            out.push(UnifiedEvent::ToolEnd {
                tool_call_id,
                is_error,
                result: normalized_result,
            });
            if let Some(plan) = maybe_plan {
                out.push(UnifiedEvent::PlanUpdate { plan });
            }
        }
        out
    }

    fn handle_result(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let mut out = Vec::new();

        // 若流异常中断未收到 message_stop, 在此兜底收口当前气泡
        if self.active_stream {
            let usage = self.pending_usage.take();
            if usage.is_some() {
                self.turn_had_usage = true;
            }
            let stop_reason = self.pending_stop_reason.take();
            out.push(UnifiedEvent::AssistantEnd {
                usage,
                stop_reason,
                error_message: None,
            });
            self.active_stream = false;
            self.current_msg_id = None;
        }

        let is_error = frame
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_error {
            let msg = frame
                .get("result")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Claude Code 执行失败");
            out.push(UnifiedEvent::Notice {
                id: None,
                notify_type: NotifyLevel::Error,
                message: msg.to_string(),
                from_extension: false,
            });
        }

        let cost = frame.get("total_cost_usd").and_then(|v| v.as_f64());
        if !self.turn_had_usage {
            if let Some(u) = frame.get("usage") {
                let mut parsed = parse_claude_usage(u);
                parsed.cost = cost;
                out.push(UnifiedEvent::AssistantEnd {
                    usage: Some(parsed),
                    stop_reason: None,
                    error_message: None,
                });
            }
        } else if let Some(c) = cost {
            if c > 0.0 {
                out.push(UnifiedEvent::AssistantEnd {
                    usage: Some(MessageUsage {
                        input: 0,
                        output: 0,
                        cache_read: 0,
                        cache_write: 0,
                        cost: Some(c),
                        cost_detail: None,
                    }),
                    stop_reason: None,
                    error_message: None,
                });
            }
        }

        out.push(UnifiedEvent::TurnSettled);
        self.in_turn = false;
        self.active_stream = false;
        self.current_msg_id = None;
        self.streamed_msg_ids.clear();
        self.seen_tool_ids.clear();
        self.pending_usage = None;
        self.pending_stop_reason = None;
        self.turn_had_usage = false;
        out
    }

    fn handle_control_request(&self, frame: &Value) -> Vec<UnifiedEvent> {
        let request_id = frame
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let Some(req) = frame.get("request") else {
            return Vec::new();
        };
        let subtype = req.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if subtype != "can_use_tool" || request_id.is_empty() {
            return Vec::new();
        }
        let raw_tool_name = req.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
        let tool_name = req
            .get("display_name")
            .or_else(|| req.get("tool_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("工具")
            .to_string();
        let tool_call_id = req
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let description = req
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let input = req.get("input").cloned().unwrap_or(Value::Null);

        // Claude Code 的 AskUserQuestion 走 can_use_tool 控制通道:
        // 分流为统一 UserPrompt 引导回复卡片, 避免误弹工具权限审批框。
        if is_claude_ask_user_tool(raw_tool_name) || is_claude_ask_user_tool(&tool_name) {
            if let Some(prompt_req) =
                parse_claude_ask_user_question(request_id.clone(), &input, description.clone())
            {
                return vec![UnifiedEvent::UserPrompt {
                    request: prompt_req,
                }];
            }
        }
        let options = req
            .get("permission_suggestions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .enumerate()
                    .filter_map(|(i, s)| {
                        let label = s
                            .get("label")
                            .or_else(|| s.get("type"))
                            .and_then(|v| v.as_str())?
                            .to_string();
                        let kind = s
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("allow_always")
                            .to_string();
                        Some(PermissionOption {
                            id: format!("suggestion-{i}"),
                            label,
                            kind,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        vec![UnifiedEvent::PermissionRequest {
            request: PermissionRequestPayload {
                id: request_id,
                tool_name,
                tool_call_id,
                description,
                input,
                options,
            },
        }]
    }
}

pub fn parse_claude_usage(u: &Value) -> MessageUsage {
    MessageUsage {
        input: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_read: u
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_write: u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cost: None,
        cost_detail: None,
    }
}

pub fn normalize_tool_result_content(raw: Value) -> Value {
    match raw {
        Value::String(s) => serde_json::json!({
            "content": [{ "type": "text", "text": s }]
        }),
        Value::Array(arr) => serde_json::json!({ "content": arr }),
        other => serde_json::json!({
            "content": [{ "type": "text", "text": other.to_string() }]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 复现实机 claude 2.1.322 完整帧序:
    /// message_start → thinking → assistant(thinking 快照) → text_delta × N → assistant(text 快照) → message_delta → message_stop → result
    /// 断言:
    /// 1. assistant(thinking) 不得提前发射 AssistantEnd (保证后续 text_delta 实时打字机生效)
    /// 2. assistant(text) 不得重复发射 AssistantStart / TextDelta (保证回答只出现一遍)
    /// 3. 直到 message_stop 才发射 AssistantEnd
    #[test]
    fn streams_thinking_then_text_without_early_end_or_duplication() {
        let mut tr = ClaudeStreamTranslator::new();

        let ev0 = tr.translate(&json!({
            "type": "stream_event",
            "event": { "type": "message_start", "message": { "id": "msg_real_1", "usage": { "input_tokens": 10, "output_tokens": 0 } } }
        }));
        assert_eq!(ev0[0], UnifiedEvent::TurnStart);
        assert_eq!(
            ev0[1],
            UnifiedEvent::AssistantStart {
                message_id: Some("msg_real_1".into())
            }
        );

        // thinking 块 + 中间 assistant(thinking) 快照
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_start", "content_block": { "type": "thinking" } }
            })),
            vec![UnifiedEvent::ContentBlockStart {
                block: ContentBlockKind::Thinking
            }]
        );
        let mid_snap = tr.translate(&json!({
            "type": "assistant",
            "message": {
                "id": "msg_real_1",
                "stop_reason": null,
                "content": [{ "type": "thinking", "thinking": "" }],
                "usage": { "input_tokens": 10, "output_tokens": 5 }
            }
        }));
        assert!(
            mid_snap.is_empty(),
            "中间 thinking 快照不得发 AssistantEnd 或重复文本, 实际: {mid_snap:?}"
        );

        // 紧接着的 text_delta 必须正常流式输出
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_start", "content_block": { "type": "text" } }
            })),
            vec![UnifiedEvent::ContentBlockStart {
                block: ContentBlockKind::Text
            }]
        );
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "你好" } }
            })),
            vec![UnifiedEvent::TextDelta {
                delta: "你好".into()
            }]
        );
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "世界" } }
            })),
            vec![UnifiedEvent::TextDelta {
                delta: "世界".into()
            }]
        );

        // text 完成后的 assistant(text) 快照绝不能重复输出 "你好世界"
        let text_snap = tr.translate(&json!({
            "type": "assistant",
            "message": {
                "id": "msg_real_1",
                "stop_reason": null,
                "content": [{ "type": "text", "text": "你好世界" }],
                "usage": { "input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 100 }
            }
        }));
        assert!(
            text_snap.is_empty(),
            "已流式输出的 text 快照不得重复发射 TextDelta/AssistantStart, 实际: {text_snap:?}"
        );

        // message_delta + message_stop 才结算 AssistantEnd
        let _ = tr.translate(&json!({
            "type": "stream_event",
            "event": { "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 25 } }
        }));
        let stop = tr.translate(&json!({
            "type": "stream_event",
            "event": { "type": "message_stop" }
        }));
        assert_eq!(
            stop,
            vec![UnifiedEvent::AssistantEnd {
                usage: Some(MessageUsage {
                    input: 10,
                    output: 25,
                    cache_read: 100,
                    cache_write: 0,
                    cost: None,
                    cost_detail: None,
                }),
                stop_reason: Some("end_turn".into()),
                error_message: None,
            }]
        );

        let res = tr.translate(&json!({
            "type": "result",
            "is_error": false,
            "total_cost_usd": 0.01
        }));
        assert!(res.iter().any(|e| matches!(e, UnifiedEvent::TurnSettled)));
    }

    #[test]
    fn translates_tool_use_and_result_within_stream() {
        let mut tr = ClaudeStreamTranslator::new();
        let _ = tr.translate(&json!({
            "type": "stream_event",
            "event": { "type": "message_start", "message": { "id": "msg_t1" } }
        }));
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "{\"a\"" } }
            })),
            vec![UnifiedEvent::ToolCallDelta { has_delta: true }]
        );
        // assistant 快照提取 tool_use (且不提前发 AssistantEnd)
        let asst = tr.translate(&json!({
            "type": "assistant",
            "message": {
                "id": "msg_t1",
                "content": [{ "type": "tool_use", "id": "tu_1", "name": "Bash", "input": { "command": "ls" } }],
                "usage": { "input_tokens": 50, "output_tokens": 30 }
            }
        }));
        assert_eq!(
            asst,
            vec![UnifiedEvent::ToolStart {
                tool_call_id: "tu_1".into(),
                tool_name: "Bash".into(),
                args: json!({ "command": "ls" }),
            }]
        );
        let stop = tr.translate(&json!({
            "type": "stream_event",
            "event": { "type": "message_stop" }
        }));
        assert!(matches!(stop[0], UnifiedEvent::AssistantEnd { .. }));

        let tr_ev = tr.translate(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "tu_1", "content": "ok", "is_error": false }]
            }
        }));
        assert_eq!(
            tr_ev,
            vec![UnifiedEvent::ToolEnd {
                tool_call_id: "tu_1".into(),
                is_error: false,
                result: json!({ "content": [{ "type": "text", "text": "ok" }] }),
            }]
        );
    }

    #[test]
    fn translates_permission_control_request() {
        let mut tr = ClaudeStreamTranslator::new();
        let evs = tr.translate(&json!({
            "type": "control_request",
            "request_id": "req_42",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "display_name": "Bash",
                "description": "Run tests",
                "tool_use_id": "tu_9",
                "input": { "command": "npm test" },
                "permission_suggestions": [{ "type": "allow", "label": "Always allow Bash" }]
            }
        }));
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            UnifiedEvent::PermissionRequest { request } => {
                assert_eq!(request.id, "req_42");
                assert_eq!(request.tool_name, "Bash");
                assert_eq!(request.description.as_deref(), Some("Run tests"));
                assert_eq!(request.options.len(), 1);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn routes_ask_user_question_to_user_prompt_and_todo_write_to_plan_update() {
        let mut tr = ClaudeStreamTranslator::new();
        let prompt_evs = tr.translate(&json!({
            "type": "control_request",
            "request_id": "req_ask_1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "AskUserQuestion",
                "input": {
                    "questions": [{
                        "header": "Style",
                        "question": "Which style?",
                        "multiSelect": false,
                        "options": [
                            { "label": "Compact", "description": "Less space" },
                            { "label": "Expanded", "description": "More details" }
                        ]
                    }]
                }
            }
        }));
        assert_eq!(prompt_evs.len(), 1);
        assert!(matches!(prompt_evs[0], UnifiedEvent::UserPrompt { .. }));

        let todo_evs = tr.translate(&json!({
            "type": "assistant",
            "message": {
                "id": "msg_todo_1",
                "content": [{
                    "type": "tool_use",
                    "id": "tu_todo_1",
                    "name": "TodoWrite",
                    "input": {
                        "todos": [
                            { "content": "Step A", "status": "in_progress", "activeForm": "Running Step A" }
                        ]
                    }
                }]
            }
        }));
        assert!(todo_evs.iter().any(|e| matches!(e, UnifiedEvent::ToolStart { .. })));
        assert!(todo_evs.iter().any(|e| matches!(e, UnifiedEvent::PlanUpdate { .. })));
    }
}
