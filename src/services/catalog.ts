/** The models the runtime offers, asked for when needed (a remote runtime may come up later). */
import type { ModelInfo } from "../agents/ports.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";

export class ModelCatalog {
  constructor(
    private readonly runtime: AgentRuntimePort,
    /** The model for light work (finding citations, writing index cards, planning searches). */
    private readonly lightPreference?: string,
  ) {}

  /**
   * The model for the light work around an answer: short, structured, and on the clock. The one
   * configured (FAST_MODEL), else any Haiku the runtime offers, else the default.
   */
  async light(): Promise<string> {
    const { models, defaultModel } = await this.list();
    const pref = this.lightPreference;
    const chosen = (pref && models.find((m) => m.id === pref || m.id.endsWith(`:${pref}`))) || models.find((m) => /haiku/i.test(m.id));
    return chosen?.id ?? defaultModel ?? "";
  }

  async list(): Promise<{ models: ModelInfo[]; defaultModel: string | null }> {
    try {
      return await this.runtime.models();
    } catch {
      return { models: [], defaultModel: null };
    }
  }

  /** The asked-for model, or the default when the id is unknown (a stale UI, a removed key). */
  async pick(id?: string): Promise<ModelInfo> {
    const { models, defaultModel } = await this.list();
    const model = models.find((m) => m.id === id) ?? models.find((m) => m.id === defaultModel);
    if (!model) throw new Error("No model is configured. Set ANTHROPIC_API_KEY or AWS Bedrock credentials in .env.");
    return model;
  }
}
