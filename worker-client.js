export const TRANSACTION = Symbol("transaction");

export class WorkerWrapper {
  constructor(url, options) {
    this.transactions = new Map();
    this._readySettled = false;
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    try {
      this._worker = new Worker(url, options);
    } catch (error) {
      this._readySettled = true;
      this._rejectReady(error);
      return;
    }

    this._worker.onerror = (event) => {
      if (!this._readySettled) {
        this._readySettled = true;
        this._rejectReady(event?.error ?? new Error(event?.message || "Worker startup failed"));
        return;
      }
      this._rejectAll(event?.error ?? new Error(event?.message || "Worker runtime error"));
    };

    this._worker.onmessageerror = (event) => {
      if (!this._readySettled) {
        this._readySettled = true;
        this._rejectReady(event);
        return;
      }
      this._rejectAll(event);
    };

    this._worker.onmessage = (event) => {
      if (!event.data || typeof event.data !== "object") {
        return;
      }

      const { type, id, result, error } = event.data;

      if (type === "ready") {
        this._readySettled = true;
        this._resolveReady();
        return;
      }

      if (type === "ready-error") {
        this._readySettled = true;
        this._rejectReady(new Error(error || "Worker failed to initialize"));
        return;
      }

      if (id && this.transactions.has(id)) {
        const transaction = this.transactions.get(id);
        this.transactions.delete(id);
        transaction.resolve({ value: result, error, [TRANSACTION]: transaction.token });
      }
    };
  }

  static async create(url, options) {
    const wrapper = new WorkerWrapper(url, options);
    await wrapper._readyPromise;
    return wrapper;
  }

  send(type, data, transfer) {
    const id = crypto.randomUUID();
    let resolveTransaction;
    let rejectTransaction;

    const token = {};
    const promise = new Promise((resolve, reject) => {
      resolveTransaction = resolve;
      rejectTransaction = reject;
    });

    this.transactions.set(id, {
      resolve: resolveTransaction,
      reject: rejectTransaction,
      token,
    });

    const payload = { type, id };
    if (data && typeof data === "object") {
      Object.assign(payload, data);
    }

    this._worker.postMessage(payload, transfer ?? []);
    return promise;
  }

  terminate() {
    this._worker.terminate();
    this._rejectAll(new Error("Worker terminated"));
  }

  _rejectAll(reason) {
    for (const transaction of this.transactions.values()) {
      transaction.reject(reason);
    }
    this.transactions.clear();
  }
}

export class StreamBridge {
  constructor(wrapper) {
    this._wrapper = wrapper;
    this._streams = new Map();
    this._hookMessages();
  }

  static async create(url, options) {
    const wrapper = await WorkerWrapper.create(url, options);
    return new StreamBridge(wrapper);
  }

  requestStream(config = {}) {
    const streamId = crypto.randomUUID();

    const stream = new ReadableStream({
      start: (controller) => {
        this._streams.set(streamId, controller);
      },
      cancel: () => {
        this._streams.delete(streamId);
        this._wrapper._worker.postMessage({ type: "stream-cancel", streamId });
      },
    });

    this._wrapper._worker.postMessage({
      type: "stream-start",
      streamId,
      ...config,
    });

    return stream;
  }

  send(type, data, transfer) {
    return this._wrapper.send(type, data, transfer);
  }

  terminate() {
    for (const controller of this._streams.values()) {
      try {
        controller.error(new Error("Worker terminated"));
      } catch {
        // Ignore closed streams.
      }
    }
    this._streams.clear();
    this._wrapper.terminate();
  }

  _hookMessages() {
    const worker = this._wrapper._worker;
    const original = worker.onmessage;

    worker.onmessage = (event) => {
      if (!event.data || typeof event.data !== "object") {
        return;
      }

      switch (event.data.type) {
        case "stream-chunk":
        case "stream-end":
        case "stream-error":
          this._onStreamMessage(event.data);
          return;
        default:
          if (typeof original === "function") {
            original.call(worker, event);
          }
      }
    };
  }

  _onStreamMessage({ type, streamId, chunk, error }) {
    const controller = this._streams.get(streamId);
    if (!controller) {
      return;
    }

    switch (type) {
      case "stream-chunk":
        try {
          controller.enqueue(chunk);
        } catch {
          // Ignore stream enqueue after close.
        }
        break;
      case "stream-end":
        try {
          controller.close();
        } catch {
          // Ignore close after close.
        }
        this._streams.delete(streamId);
        break;
      case "stream-error":
        try {
          controller.error(new Error(error || "Stream failed"));
        } catch {
          // Ignore duplicate errors.
        }
        this._streams.delete(streamId);
        break;
      default:
        break;
    }
  }
}
