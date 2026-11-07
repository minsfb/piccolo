import type { Models } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Public registry calls preserve managed model routing and request-time authentication. */
export function managedModels(registry: ExtensionContext["modelRegistry"]): Models {
  const unavailable = () => { throw new Error("This model operation is not exposed by the Pi 1.3 extension registry"); };
  const allModels = (provider?: string) => [...registry.getModelsOfType("chat", provider), ...registry.getModelsOfType("image", provider), ...registry.getModelsOfType("classifier", provider)];
  return {
    getProviders: () => [...new Set(allModels().map(m => m.provider))].map(id => registry.getProvider(id)!).filter(Boolean),
    getProvider: id => registry.getProvider(id),
    getModels: provider => registry.getAll().filter(m => !provider || m.provider === provider),
    getModel: (provider, id) => registry.find(provider, id),
    getModelsOfType: (type, provider) => registry.getModelsOfType(type, provider),
    getModelOfType: (type, provider, id) => registry.getModelOfType(type, provider, id),
    getAllModels: allModels,
    refresh: options => registry.refresh(options),
    getAvailable: async provider => registry.getAvailable().filter(m => !provider || m.provider === provider),
    getAvailableOfType: (type, provider, options) => registry.getAvailableOfType(type, provider, options),
    getAllAvailable: async (provider, options) => (await Promise.all([registry.getAvailableOfType("chat", provider, options), registry.getAvailableOfType("image", provider, options), registry.getAvailableOfType("classifier", provider, options)])).flat(),
    stream: (model, transcript, options) => registry.stream(model, transcript, options),
    complete: (model, transcript, options) => registry.complete(model, transcript, options),
    streamSimple: (model, transcript, options) => {
      if (options?.deferred) throw new Error("Deferred model requests are not supported by this worker adapter");
      return registry.streamSimple(model, transcript, options);
    },
    completeSimple: (model, transcript, options) => {
      if (options?.deferred) throw new Error("Deferred model requests are not supported by this worker adapter");
      return registry.streamSimple(model, transcript, options).result();
    },
    classify: (model, transcript, options) => registry.classify(model, transcript, options),
    generateImages: (model, transcript, options) => registry.generateImages(model, transcript, options),
    checkAuth: unavailable, getAuth: unavailable, login: unavailable, logout: unavailable,
    streamDeferred: unavailable, fetchDeferred: unavailable, cancelDeferred: unavailable,
  };
}
