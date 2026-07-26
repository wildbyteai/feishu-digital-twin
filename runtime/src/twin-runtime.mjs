import { TwinService } from "./service.mjs";

export class TwinRuntime {
  constructor({
    inferenceAdapter,
    refreshConfig,
    createGuard,
    ...serviceOptions
  } = {}) {
    if (!inferenceAdapter || typeof inferenceAdapter.decide !== "function") {
      throw new TypeError("inferenceAdapter.decide is required");
    }
    this.inferenceAdapter = inferenceAdapter;
    if (refreshConfig !== undefined && typeof refreshConfig !== "function") {
      throw new TypeError("refreshConfig must be a function");
    }
    if (createGuard !== undefined && typeof createGuard !== "function") {
      throw new TypeError("createGuard must be a function");
    }
    if (refreshConfig && !createGuard) {
      throw new TypeError("createGuard is required when refreshConfig is configured");
    }
    this.serviceOptions = serviceOptions;
    this.refreshConfig = refreshConfig ?? (async () => serviceOptions.config);
    this.createGuard = createGuard ?? (() => serviceOptions.guard);
    this.usesRuntimeSnapshots = refreshConfig !== undefined;
    this.service = this.#createService(serviceOptions.config);
  }

  #createService(config) {
    const guard = this.createGuard(config);
    return new TwinService({
      ...this.serviceOptions,
      config,
      guard,
      ...(this.usesRuntimeSnapshots
        ? { refreshProductionEnabled: async () => config.production_enabled === true }
        : {}),
      runCodex: (event, options = {}) => this.inferenceAdapter.decide({
        event,
        promptContext: options.promptContext ?? {}
      })
    });
  }

  async handle(event) {
    if (!this.usesRuntimeSnapshots) return this.service.handle(event);
    const config = await this.refreshConfig();
    return this.#createService(config).handle(event);
  }

  async runDailyMemory(targetDate, options) {
    if (!this.usesRuntimeSnapshots) return this.service.runDailyMemory(targetDate, options);
    const config = await this.refreshConfig();
    return this.#createService(config).runDailyMemory(targetDate, options);
  }
}
