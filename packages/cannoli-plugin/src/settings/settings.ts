import {
  BakeLanguage,
  BakeRuntime,
  HttpTemplate,
  SupportedProviders,
} from "@deablabs/cannoli-core";

/** Provider kinds in settings v3. */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "ollama"
  | "openai-compatible";

/**
 * `<provider profile id>:<model>`, e.g. `openai:gpt-4o` or `groq:llama3-70b-8192`.
 * The prefix is a profile id, which for openai-compatible profiles is not a ProviderId.
 */
export type ModelRef = `${string}:${string}`;

export interface ProviderProfile {
  id: ProviderId | string;
  kind: ProviderId;
  baseURL?: string;
  enabled: boolean;
  /** SecretStorage id of the API key. */
  secretId?: string;
}

export interface ModelRoles {
  call: ModelRef;
  agent: ModelRef;
  router: ModelRef;
  orchestrator?: ModelRef;
  local?: ModelRef;
}

export interface UserSecret {
  name: string;
  /** Legacy plaintext value; blank once moved to SecretStorage. */
  value: string;
  visibility: string;
  /** SecretStorage id holding the value. */
  secretId?: string;
}

export interface CannoliSettings {
  // Settings v3 (additive: the v2 fields below are still read by the runtime).
  settingsVersion?: 3;
  providers: ProviderProfile[];
  models: ModelRoles;
  concurrency: { pLimit: number; requestThreshold: number };
  network: { allow: string[]; allowLocalhost: boolean };
  /** Which library calls the models. Installs from before it existed keep "langchain". */
  providerEngine: "ai-sdk" | "langchain";
  /** SecretStorage ids for the non-provider keys. */
  valTownSecretId: string;
  exaSecretId: string;
  cannoliServerSecretId: string;

  llmProvider: SupportedProviders;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTemperature: number;
  azureAPIKey: string;
  azureModel: string;
  azureTemperature: number;
  azureOpenAIApiDeploymentName: string;
  azureOpenAIApiInstanceName: string;
  azureOpenAIApiVersion: string;
  azureBaseURL: string;
  geminiModel: string;
  geminiAPIKey: string;
  geminiTemperature: number;
  anthropicModel: string;
  anthropicAPIKey: string;
  anthropicTemperature: number;
  anthropicBaseURL: string;
  groqModel: string;
  groqAPIKey: string;
  groqTemperature: number;
  openaiAPIKey: string;
  openaiBaseURL: string;
  requestThreshold: number;
  defaultModel: string;
  defaultTemperature: number;
  httpTemplates: HttpTemplate[];
  includeFilenameAsHeader: boolean;
  includePropertiesInExtractedNotes: boolean;
  includeLinkInExtractedNotes: boolean;
  chatFormatString: string;
  enableAudioTriggeredCannolis?: boolean;
  deleteAudioFilesAfterAudioTriggeredCannolis?: boolean;
  transcriptionPrompt?: string;
  autoScrollWithTokenStream: boolean;
  pLimit: number;
  contentIsColorless: boolean;
  valTownAPIKey: string;
  exaAPIKey: string;
  bakedCannoliFolder: string;
  bakeLanguage: BakeLanguage;
  bakeRuntime: BakeRuntime;
  bakeIndent: "2" | "4";
  seenVersion2Modal: boolean;
  enableVision: boolean;
  secrets: UserSecret[];
  onlyRunCannoliGroups: boolean;
  cannoliServerEnabled: boolean;
  cannoliServerUrl: string;
  cannoliServerSecret: string;
  seenVersion3Modal: boolean;
}

export const DEFAULT_SETTINGS: CannoliSettings = {
  settingsVersion: 3,
  providers: [
    {
      id: "openai",
      kind: "openai",
      enabled: true,
      secretId: "cannoli-key-openai",
    },
    {
      id: "anthropic",
      kind: "anthropic",
      enabled: false,
      secretId: "cannoli-key-anthropic",
    },
    {
      id: "google",
      kind: "google",
      enabled: false,
      secretId: "cannoli-key-google",
    },
    {
      id: "ollama",
      kind: "ollama",
      baseURL: "http://127.0.0.1:11434",
      enabled: false,
    },
    {
      id: "groq",
      kind: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      enabled: false,
      secretId: "cannoli-key-groq",
    },
    {
      id: "azure",
      kind: "openai-compatible",
      enabled: false,
      secretId: "cannoli-key-azure",
    },
  ],
  models: {
    call: "openai:gpt-4o",
    agent: "openai:gpt-4o",
    router: "openai:gpt-4o",
    local: "ollama:llama2",
  },
  concurrency: { pLimit: 50, requestThreshold: 20 },
  network: { allow: [], allowLocalhost: true },
  providerEngine: "ai-sdk",
  valTownSecretId: "cannoli-secret-valtown-api-key",
  exaSecretId: "cannoli-secret-exa-api-key",
  cannoliServerSecretId: "cannoli-secret-cannoli-server",
  llmProvider: "openai",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaModel: "llama2",
  ollamaTemperature: 1,
  azureModel: "",
  azureAPIKey: "",
  azureTemperature: 1,
  azureOpenAIApiDeploymentName: "",
  azureOpenAIApiInstanceName: "",
  azureOpenAIApiVersion: "",
  azureBaseURL: "",
  geminiModel: "gemini-1.0-pro-latest",
  geminiAPIKey: "",
  geminiTemperature: 1,
  anthropicModel: "claude-3-5-sonnet-20240620",
  anthropicAPIKey: "",
  anthropicTemperature: 1,
  anthropicBaseURL: "",
  groqModel: "llama3-70b-8192",
  groqAPIKey: "",
  groqTemperature: 1,
  openaiAPIKey: "",
  openaiBaseURL: "",
  requestThreshold: 20,
  defaultModel: "gpt-4o",
  defaultTemperature: 1,
  httpTemplates: [],
  includeFilenameAsHeader: false,
  includePropertiesInExtractedNotes: false,
  includeLinkInExtractedNotes: false,
  chatFormatString: `---\n# <u>{{role}}</u>\n\n{{content}}`,
  enableAudioTriggeredCannolis: false,
  deleteAudioFilesAfterAudioTriggeredCannolis: false,
  autoScrollWithTokenStream: false,
  pLimit: 50,
  contentIsColorless: false,
  valTownAPIKey: "",
  exaAPIKey: "",
  bakedCannoliFolder: "Baked Cannoli",
  bakeLanguage: "typescript",
  bakeRuntime: "node",
  bakeIndent: "2",
  secrets: [],
  enableVision: true,
  onlyRunCannoliGroups: false,
  cannoliServerEnabled: false,
  cannoliServerUrl: "http://localhost:3333",
  cannoliServerSecret: "",
  seenVersion2Modal: true,
  seenVersion3Modal: false,
};
