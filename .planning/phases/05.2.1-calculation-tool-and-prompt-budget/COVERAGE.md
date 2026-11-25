# API Coverage — OpenRouter and OpenAI-compatible chat completions (existing integration)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> Phase 5.2.1 adds no new external service. It uses more of the chat-completion APIs the app and the voice agent already call: the AI SDK tool loop on the chat and eval paths (plans 05.2.1-14, 05.2.1-17), function tools with streamed tool-call deltas in the voice agent (plan 05.2.1-19), OpenRouter's context-compression plugin switched off (plans 05.2.1-20, 05.2.1-21, 05.2.1-22), provider-reported prompt tokens for calibration (plans 05.2.1-08, 05.2.1-20, 05.2.1-25), and the public model list for context windows (plan 05.2.1-02). The internal routes `/api/internal/voice-calc` and `/api/internal/voice-rag` are the app's own and are not listed.

| capability | decision | reason |
|---|---|---|
| openrouter.chat.plugins.context_compression_disabled | INTEGRATE | |
| openrouter.chat.usage.prompt_tokens | INTEGRATE | |
| openrouter.models.context_length | INTEGRATE | |
| ai_sdk.tool.input_schema_generated_zod | INTEGRATE | |
| ai_sdk.stream_text.multi_step_tool_loop | INTEGRATE | |
| ai_sdk.generate_text.tool_loop_eval | INTEGRATE | |
| openai_compatible.chat.tools.function_definition | INTEGRATE | |
| openai_compatible.chat.stream.tool_call_deltas | INTEGRATE | |
| openai_compatible.chat.tool_result_messages | INTEGRATE | |
| openai_compatible.chat.multiple_tool_calls_per_response | INTEGRATE | |
| openrouter.chat.transforms_middle_out_legacy_field | OPT-OUT | not needed: only the documented plugin form is sent (05.2-RESEARCH "State of the Art") |
| openrouter.chat.context_compression_enabled | OPT-OUT | explicitly out of scope: D-84 forbids relying on provider-side compression or truncation |
| provider.tokenizer_or_token_count_endpoint | OPT-OUT | explicitly out of scope: D-81 calls no provider tokenizer on the request path; counts come from cl100k times a calibrated factor |
| openai_compatible.chat.response_format_json_on_streamed_answer | OPT-OUT | explicitly out of scope: Phase 5 D-04 forbids JSON mode on the streamed answer; models without tools use the trailing block (D-72) |
| openai_compatible.chat.parallel_tool_calls_request_flag | OPT-OUT | not needed: the agent handles several calls in one response without setting the flag; the default behaviour is kept |
| anthropic.citations_with_tool_calls | OPT-OUT | not needed yet: D-71 keeps calculation turns on the chunk-alias path until the Phase 5 D-10 proof for tool turns exists |
| fact_tools_as_calculation_operands | OPT-OUT | explicitly out of scope: the `fact_tool` source kind is reserved for the SEC-05 design only (CONTEXT Deferred Ideas) |
