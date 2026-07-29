import { TwinService } from "./service.mjs";

function capabilityGatewayForConfig(gateway, config) {
  if (gateway === undefined || !Array.isArray(config.allowed_capabilities)) return gateway;
  const allowed = new Set(config.allowed_capabilities);
  return {
    snapshot() {
      return gateway.snapshot().filter(({ capability }) => allowed.has(capability));
    },
    async lookup(request, trustedContext) {
      if (!allowed.has(request?.capability)) {
        return {
          capability: typeof request?.capability === "string" && request.capability.length > 0
            ? request.capability
            : "unknown",
          operation: typeof request?.operation === "string" && request.operation.length > 0
            ? request.operation
            : "unknown",
          status: "unavailable"
        };
      }
      return gateway.lookup(request, trustedContext);
    }
  };
}

function capabilityActionGatewayForConfig(gateway, config) {
  if (gateway === undefined || !Array.isArray(config.allowed_capabilities)) return gateway;
  const allowed = new Set(config.allowed_capabilities);
  return {
    snapshot() {
      return gateway.snapshot().filter(({ capability }) => allowed.has(capability));
    },
    async prepare(request) {
      if (!allowed.has(request?.capability)) {
        return {
          capability: typeof request?.capability === "string" && request.capability.length > 0
            ? request.capability
            : "unknown",
          operation: typeof request?.operation === "string" && request.operation.length > 0
            ? request.operation
            : "unknown",
          status: "unavailable"
        };
      }
      return gateway.prepare(request);
    },
    async confirm(pendingAction) {
      return gateway.confirm(pendingAction, { allowedCapabilities: allowed });
    },
    cancel(pendingAction) {
      return gateway.cancel(pendingAction);
    }
  };
}

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
      capabilityGateway: capabilityGatewayForConfig(
        this.serviceOptions.capabilityGateway,
        config
      ),
      capabilityActionGateway: capabilityActionGatewayForConfig(
        this.serviceOptions.capabilityActionGateway,
        config
      ),
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
