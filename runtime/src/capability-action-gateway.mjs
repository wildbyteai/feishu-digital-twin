import { randomUUID } from "node:crypto";

import {
  normalizeCapabilityAdapterResult,
  validateCapabilityLookupRequest
} from "./capability-gateway.mjs";

const MAX_PENDING_ACTION_BYTES = 8 * 1024;
const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function boundedPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_PENDING_ACTION_BYTES;
  } catch {
    return false;
  }
}

function discardPending(pendingActions, actionId) {
  const pending = pendingActions.get(actionId);
  if (!pending) return false;
  if (pending.expiration_timer !== undefined) clearTimeout(pending.expiration_timer);
  return pendingActions.delete(actionId);
}

function validateActionCapability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("action capability must be an object");
  }
  if (
    typeof value.capability !== "string" ||
    value.capability.length === 0 ||
    typeof value.purpose !== "string" ||
    value.purpose.length === 0 ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.some((operation) => typeof operation !== "string" || operation.length === 0) ||
    value.risk !== "approval" ||
    value.trust_zone !== "internal" ||
    !new Set(["ready", "unavailable"]).has(value.readiness) ||
    typeof value.input_description !== "string" ||
    value.input_description.length === 0
  ) {
    throw new TypeError("action capability is invalid");
  }
  return structuredClone(value);
}

function stableResult(request, status) {
  return {
    capability: typeof request?.capability === "string" && request.capability.length > 0
      ? request.capability
      : "unknown",
    operation: typeof request?.operation === "string" && request.operation.length > 0
      ? request.operation
      : "unknown",
    status
  };
}

export class CapabilityActionGateway {
  constructor({
    actionCapabilities = [],
    actionAdapters = new Map(),
    pendingActionTtlMs = PENDING_ACTION_TTL_MS
  } = {}) {
    if (!Array.isArray(actionCapabilities)) {
      throw new TypeError("actionCapabilities must be an array");
    }
    if (!(actionAdapters instanceof Map)) throw new TypeError("actionAdapters must be a Map");
    if (
      !Number.isInteger(pendingActionTtlMs) ||
      pendingActionTtlMs < 1 ||
      pendingActionTtlMs > PENDING_ACTION_TTL_MS
    ) {
      throw new TypeError("pendingActionTtlMs must be a positive bounded integer");
    }
    this.capabilities = new Map();
    this.pending = new Map();
    this.pendingActionTtlMs = pendingActionTtlMs;
    for (const raw of actionCapabilities) {
      const snapshot = validateActionCapability(raw);
      if (this.capabilities.has(snapshot.capability)) {
        throw new TypeError("action capability identifiers must be unique");
      }
      const adapter = actionAdapters.get(snapshot.capability);
      if (adapter !== undefined && (
        typeof adapter?.prepare !== "function" ||
        typeof adapter?.confirm !== "function"
      )) {
        throw new TypeError("action adapter.prepare and action adapter.confirm are required");
      }
      this.capabilities.set(snapshot.capability, { snapshot, adapter });
    }
  }

  snapshot() {
    return [...this.capabilities.values()].map(({ snapshot }) => structuredClone(snapshot));
  }

  async prepare(rawRequest) {
    let request;
    try {
      request = validateCapabilityLookupRequest(rawRequest);
    } catch {
      return stableResult(rawRequest, "invalid-input");
    }
    const registered = this.capabilities.get(request.capability);
    if (!registered || registered.snapshot.readiness !== "ready" || !registered.adapter) {
      return stableResult(request, "unavailable");
    }
    if (!registered.snapshot.operations.includes(request.operation)) {
      return stableResult(request, "invalid-input");
    }
    let result;
    try {
      result = await registered.adapter.prepare(structuredClone(request));
    } catch {
      return stableResult(request, "failed");
    }
    if (
      !result ||
      result.status !== "confirmation-required" ||
      !boundedPayload(result.pending_action)
    ) {
      return normalizeCapabilityAdapterResult(request, result);
    }
    const preview = normalizeCapabilityAdapterResult(request, {
      status: "complete",
      data: result.preview,
      source_refs: []
    });
    if (preview.status !== "complete") return stableResult(request, "failed");
    const now = Date.now();
    for (const [actionId, pending] of this.pending) {
      if (now - pending.created_at >= this.pendingActionTtlMs) {
        discardPending(this.pending, actionId);
      }
    }
    const actionId = randomUUID();
    const expirationTimer = setTimeout(() => {
      this.pending.delete(actionId);
    }, this.pendingActionTtlMs);
    expirationTimer.unref?.();
    this.pending.set(actionId, {
      capability: request.capability,
      operation: request.operation,
      payload: structuredClone(result.pending_action),
      created_at: now,
      expiration_timer: expirationTimer
    });
    return {
      ...stableResult(request, "confirmation-required"),
      preview: preview.data,
      pending_action: {
        capability: request.capability,
        operation: request.operation,
        action_id: actionId
      }
    };
  }

  async confirm(pendingAction, { allowedCapabilities } = {}) {
    if (allowedCapabilities !== undefined && !(allowedCapabilities instanceof Set)) {
      throw new TypeError("allowedCapabilities must be a Set");
    }
    const idOnly = exactFields(pendingAction, ["action_id"]);
    const fullyBound = exactFields(pendingAction, ["action_id", "capability", "operation"]);
    if (
      (!idOnly && !fullyBound) ||
      typeof pendingAction.action_id !== "string" ||
      pendingAction.action_id.length === 0 ||
      (fullyBound && (
        typeof pendingAction.capability !== "string" ||
        typeof pendingAction.operation !== "string"
      ))
    ) {
      return stableResult(pendingAction, "invalid-input");
    }
    const trusted = this.pending.get(pendingAction.action_id);
    if (
      !trusted ||
      (fullyBound && trusted.capability !== pendingAction.capability) ||
      (fullyBound && trusted.operation !== pendingAction.operation) ||
      Date.now() - trusted.created_at >= this.pendingActionTtlMs
    ) {
      discardPending(this.pending, pendingAction.action_id);
      return stableResult(pendingAction, "invalid-input");
    }
    const trustedRequest = {
      capability: trusted.capability,
      operation: trusted.operation
    };
    if (allowedCapabilities && !allowedCapabilities.has(trusted.capability)) {
      discardPending(this.pending, pendingAction.action_id);
      return stableResult(trustedRequest, "unavailable");
    }
    const registered = this.capabilities.get(trusted.capability);
    if (!registered || registered.snapshot.readiness !== "ready" || !registered.adapter) {
      discardPending(this.pending, pendingAction.action_id);
      return stableResult(trustedRequest, "unavailable");
    }
    if (!registered.snapshot.operations.includes(trusted.operation)) {
      discardPending(this.pending, pendingAction.action_id);
      return stableResult(trustedRequest, "invalid-input");
    }
    discardPending(this.pending, pendingAction.action_id);
    try {
      return normalizeCapabilityAdapterResult(
        trustedRequest,
        await registered.adapter.confirm(
          structuredClone(trusted.payload),
          trusted.operation
        )
      );
    } catch {
      return stableResult(trustedRequest, "failed");
    }
  }

  cancel(pendingAction) {
    if (
      !exactFields(pendingAction, ["action_id"]) ||
      typeof pendingAction.action_id !== "string" ||
      pendingAction.action_id.length === 0
    ) {
      return false;
    }
    return discardPending(this.pending, pendingAction.action_id);
  }
}
