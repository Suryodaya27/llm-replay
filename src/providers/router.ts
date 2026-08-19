/**
 * Provider Router — picks the right adapter based on model name.
 *
 * Routing logic:
 * 1. Check explicit routes (model prefix → provider)
 * 2. Check provider model lists
 * 3. Fall back to default provider
 *
 * Config example:
 * {
 *   providers: {
 *     ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' },
 *     openai: { type: 'openai', baseUrl: 'https://api.openai.com', apiKey: '...' },
 *     anthropic: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '...' },
 *   },
 *   routes: {
 *     'gpt-': 'openai',
 *     'claude-': 'anthropic',
 *   },
 *   default: 'ollama'
 * }
 */

import type { Provider, RouterConfig, ProviderConfig } from './types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

export class ProviderRouter {
  private providers = new Map<string, Provider>();
  private routes: Array<{ prefix: string; providerName: string }> = [];
  private defaultProvider: string;

  constructor(config: RouterConfig) {
    this.defaultProvider = config.default;

    // Instantiate providers
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      this.providers.set(name, createProvider(providerConfig));
    }

    // Sort routes by prefix length (longest first for specificity)
    this.routes = Object.entries(config.routes)
      .map(([prefix, providerName]) => ({ prefix, providerName }))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    if (!this.providers.has(this.defaultProvider)) {
      throw new Error(`Default provider "${this.defaultProvider}" not found in config`);
    }
  }

  /** Route a model name to the correct provider */
  resolve(model: string): Provider {
    // Check prefix routes
    for (const route of this.routes) {
      if (model.startsWith(route.prefix)) {
        const provider = this.providers.get(route.providerName);
        if (provider) return provider;
      }
    }

    // Check provider model lists
    for (const [, provider] of this.providers) {
      // Provider-specific model matching handled by the provider itself
    }

    // Fall back to default
    return this.providers.get(this.defaultProvider)!;
  }

  /** Get a specific provider by name */
  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** List all registered provider names */
  list(): string[] {
    return [...this.providers.keys()];
  }

  /** Health check all providers */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, provider] of this.providers) {
      results[name] = await provider.healthCheck();
    }
    return results;
  }
}

function createProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

/** Build a default router config (Ollama only, no API keys needed) */
export function defaultRouterConfig(): RouterConfig {
  return {
    providers: {
      ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' },
    },
    routes: {},
    default: 'ollama',
  };
}

/** Build a full router config from env vars */
export function routerConfigFromEnv(): RouterConfig {
  const config: RouterConfig = {
    providers: {
      ollama: { type: 'ollama', baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434' },
    },
    routes: {},
    default: 'ollama',
  };

  if (process.env.OPENAI_API_KEY) {
    config.providers.openai = {
      type: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY,
    };
    config.routes['gpt-'] = 'openai';
    config.routes['o1'] = 'openai';
    config.routes['o3'] = 'openai';
  }

  if (process.env.ANTHROPIC_API_KEY) {
    config.providers.anthropic = {
      type: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
    config.routes['claude-'] = 'anthropic';
  }

  return config;
}
