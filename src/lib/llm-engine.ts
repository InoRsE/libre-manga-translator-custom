import { MLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import type { AppConfig, MLCEngineConfig } from "@mlc-ai/web-llm";
import { DefaultConfig } from "./configs";

/**
 * WebLLM app config = prebuilt model list + DefaultConfig.llmModelOverrides
 * merged onto each matching ModelRecord.overrides (which themselves are
 * merged on top of the model's downloaded mlc-chat-config.json at reload).
 *
 * Without this, gemma3-1b fails to load with WindowSizeConfigurationError
 * (both context_window_size and sliding_window_size positive).
 */
export const llmAppConfig: AppConfig = {
  ...prebuiltAppConfig, // keeps cacheBackend: "cache" + every prebuilt record
  model_list: prebuiltAppConfig.model_list.map((rec) => {
    const patch = DefaultConfig.llmModelOverrides[rec.model_id];
    return patch ? { ...rec, overrides: { ...rec.overrides, ...patch } } : rec;
  }),
};

/**
 * Single constructor for local LLM engines so per-model overrides always
 * apply — never `new MLCEngine(...)` directly.
 */
export function createLlmEngine(
  config: Omit<MLCEngineConfig, "appConfig"> = {},
): MLCEngine {
  return new MLCEngine({ ...config, appConfig: llmAppConfig });
}
