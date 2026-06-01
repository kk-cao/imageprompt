(function initRiptHistoryStore(global) {
  const DB_NAME = "ript_history_db";
  const DB_VERSION = 1;
  const STORE_NAME = "history";
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 打开失败。"));
    });

    return dbPromise;
  }

  async function withStore(mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("历史数据库操作失败。"));
      transaction.onabort = () => reject(transaction.error || new Error("历史数据库操作已中止。"));

      try {
        result = callback(store);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("历史数据库请求失败。"));
    });
  }

  async function put(entry) {
    await withStore("readwrite", (store) => {
      store.put(normalizeEntry(entry));
    });
  }

  async function putMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    await withStore("readwrite", (store) => {
      entries.forEach((entry) => store.put(normalizeEntry(entry)));
    });
  }

  async function get(id) {
    return withStore("readonly", (store) => requestToPromise(store.get(id)));
  }

  async function getAll() {
    const entries = await withStore("readonly", (store) => requestToPromise(store.getAll()));
    return sortNewestFirst(entries || []);
  }

  async function getRecent(limit = 50) {
    const max = Number(limit);
    if (!Number.isFinite(max) || max <= 0) return getAll();

    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const index = transaction.objectStore(STORE_NAME).index("createdAt");
      const entries = [];
      const request = index.openCursor(null, "prev");

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || entries.length >= max) {
          resolve(entries);
          return;
        }
        entries.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("读取历史记录失败。"));
      transaction.onerror = () => reject(transaction.error || new Error("读取历史记录失败。"));
    });
  }

  async function count() {
    return withStore("readonly", (store) => requestToPromise(store.count()));
  }

  async function remove(id) {
    await withStore("readwrite", (store) => {
      store.delete(id);
    });
  }

  async function clear() {
    await withStore("readwrite", (store) => {
      store.clear();
    });
  }

  async function update(id, changes) {
    const entry = await get(id);
    if (!entry) return null;
    const nextEntry = normalizeEntry({
      ...entry,
      ...changes
    });
    await put(nextEntry);
    return nextEntry;
  }

  async function enforceLimit(limit) {
    const max = Number(limit);
    if (!Number.isFinite(max) || max <= 0) return;

    const entries = await getAll();
    if (entries.length <= max) return;

    const staleEntries = entries.slice(max);
    await withStore("readwrite", (store) => {
      staleEntries.forEach((entry) => store.delete(entry.id));
    });
  }

  async function importEntries(entries, options = {}) {
    const importedAt = Date.now();
    const normalizedEntries = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry === "object")
      .map((entry, index) => normalizeEntry({
        ...entry,
        id: options.keepIds && entry.id
          ? String(entry.id)
          : `${importedAt}-${index}-${Math.random().toString(36).slice(2, 8)}`
      }));

    await putMany(normalizedEntries);
    return normalizedEntries.length;
  }

  function normalizeEntry(entry) {
    return {
      id: String(entry?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      createdAt: Number(entry?.createdAt) || Date.now(),
      srcUrl: String(entry?.srcUrl || ""),
      image: String(entry?.image || ""),
      model: String(entry?.model || ""),
      zh: String(entry?.zh || ""),
      en: String(entry?.en || ""),
      json: entry?.json ? formatJson(entry.json) : ""
    };
  }

  function sortNewestFirst(entries) {
    return entries.slice().sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
  }

  function formatJson(value) {
    if (typeof value !== "string") {
      return JSON.stringify(value || {}, null, 2);
    }
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  global.RiptHistoryStore = {
    put,
    putMany,
    get,
    getAll,
    getRecent,
    count,
    remove,
    clear,
    update,
    enforceLimit,
    importEntries
  };
})(globalThis);