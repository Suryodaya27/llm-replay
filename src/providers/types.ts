/**
 * Provider Interface — unified contract for all LLM backends.
 *
 * Each provider adapter implements this interface. The proxy doesn't
 * know or care whether it's talking to Ollama, OpenAI, or Anthropic.
 * It just calls provider.chat() and gets a standard response back.
 */

// --- Unified request/response (internal format) ---

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Raw provider-specific options passed through untouched */
  raw_options?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  model: string;
  finish_reason?: string;
  tokens?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Raw provider response (stored in session for full fidelity) */
  raw: unknown;
  latency_ms: number;
}

export interface StreamChunk {
  index: number;
  content: string;  // token text for this chunk
  done: boolean;
  /** Raw chunk from provider */
  raw: unknown;
}

// --- Provider interface ---

export interface Provider {
  name: string;

  /** Send a non-streaming chat request */
  chat(req: ChatRequest): Promise<ChatResponse>;

  /** Send a streaming chat request, yields chunks */
  chatStream(req: ChatRequest): AsyncGenerator<StreamChunk>;

  /** Check if this provider is reachable */
  healthCheck(): Promise<boolean>;
}

// --- Provider config ---

export interface ProviderConfig {
  /** Provider type */
  type: 'ollama' | 'openai' | 'anthropic';
  /** Base URL for the provider API */
  baseUrl: string;
  /** API key (not needed for Ollama) */
  apiKey?: string;
  /** Models this provider handles (if empty, matches by routing rules) */
  models?: string[];
}

/** Full config mapping model patterns to providers */
export interface RouterConfig {
  providers: Record<string, ProviderConfig>;
  /** Route rules: model prefix → provider name */
  routes: Record<string, string>;
  /** Default provider when no route matches */
  default: string;
}
